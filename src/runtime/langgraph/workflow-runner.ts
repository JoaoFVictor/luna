import {
  END,
  START,
  StateGraph
} from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type {
  AgentRuntimePort,
  AgentRuntimeRequirement,
  RunAgentInput
} from "../../core/agent-runtime/contracts.js";
import type { BuiltInStepMetadata } from "../../core/built-ins/types.js";
import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../core/capabilities/pattern-registration.js";
import { runtimeError } from "../../core/runtime/errors.js";
import {
  assertCheckpointJsonValue,
  stableJson,
  type JsonObject,
  type JsonValue
} from "../../core/runtime/json.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import {
  LUNA_RUNTIME_STATE_SCHEMA_VERSION,
  createInitialRuntimeState,
  publishNodeOutput,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import {
  markNodeWaitingForInput,
  startNodeAttempt,
  succeedNode
} from "../../core/runtime/lifecycle.js";
import {
  createInterrupt,
  resumeInterrupt
} from "../../core/runtime/interrupts/resume.js";
import {
  selectReadyBatchWithPolicy,
  splitDeferredFinalReportNodesByPolicy,
  type ExecutionPolicyDecision,
  type WorkflowExecutionNode
} from "../../core/workflow/execution-policy.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";
import {
  dependenciesByNode,
  readyNodes
} from "../../core/workflow/runner-graph.js";
import { resolveNodeInput } from "../../core/workflow/runner-input.js";
import { finalWorkflowOutput } from "../../core/workflow/runner-output.js";
import {
  withWorkflowLocks
} from "../../core/workflow/runner-locks.js";
import {
  promoteWorkspaceOutput,
  rehydrateRuntimeContextFromSteps,
  runtimeContextSnapshot
} from "../../core/workflow/runner-context.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import type {
  CompiledWorkflow,
  CompiledWorkflowNode
} from "../../core/workflow/compiler.js";
import {
  WorkflowStateAnnotation,
  type WorkflowGraphState,
  type WorkflowGraphUpdate
} from "./workflow-state.js";
import { executeGatedAgentLoopNode } from "./gated-agent-loop-executor.js";
import type {
  ResumeCompiledWorkflowInput,
  RunCompiledWorkflowInput,
  WorkflowAgentDefaults,
  WorkflowAgentInputMap,
  WorkflowRunResult
} from "./workflow-runner-types.js";

export type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
export type {
  ResumeCompiledWorkflowInput,
  RunCompiledWorkflowInput,
  WorkflowAgentDefaults,
  WorkflowAgentInputMap,
  WorkflowBuiltInExecutor,
  WorkflowBuiltInMetadataResolver,
  WorkflowRunResult
} from "./workflow-runner-types.js";

type RunnerPolicyNode = WorkflowExecutionNode & {
  readonly compiled: CompiledWorkflowNode;
};

type LangGraphEdge = {
  readonly from: string;
  readonly to: string;
};

type PolicyEdgePlan = {
  readonly edges: LangGraphEdge[];
  readonly delayedNodeIds: ReadonlySet<string>;
};

type DynamicStateGraph = {
  addNode(
    key: string,
    action: (state: WorkflowGraphState) => Promise<WorkflowGraphUpdate>
  ): void;
  addEdge(from: string, to: string): void;
  compile(options: {
    readonly name: string;
    readonly checkpointer?: BaseCheckpointSaver;
  }): {
    invoke(
      state: LunaRuntimeState,
      options: { readonly configurable: { readonly thread_id: string } }
    ): Promise<WorkflowGraphState>;
  };
};

class WorkflowWaitingForInput extends Error {
  readonly result: Extract<WorkflowRunResult, { status: "waiting_for_input" }>;

  constructor(result: Extract<WorkflowRunResult, { status: "waiting_for_input" }>) {
    super("Workflow is waiting for input");
    this.name = "WorkflowWaitingForInput";
    this.result = result;
  }
}

export async function runCompiledWorkflow(
  input: RunCompiledWorkflowInput
): Promise<WorkflowRunResult> {
  assertCompiledWorkflowMatchesDefinition(input);
  assertSupportedExecutionSubset(input);
  assertSupportedRuntimeRequirements(input, 0);
  const state = createInitialRuntimeState({
    invocation: input.invocation,
    config: input.config,
    run: input.run,
    workflow: { id: input.workflow.id, mode: input.workflow.mode }
  });
  await appendEvent(input, "run.started");

  return await runFromNodeIndex(input, state, 0);
}

export async function resumeCompiledWorkflow(
  input: ResumeCompiledWorkflowInput
): Promise<WorkflowRunResult> {
  assertCompiledWorkflowMatchesDefinition(input);
  assertSupportedExecutionSubset(input);
  const checkpoint = await input.backends.checkpoints.load(input.thread_id, {
    checkpointId: input.checkpoint_id,
    expectedStateSchemaVersion: LUNA_RUNTIME_STATE_SCHEMA_VERSION
  });
  if (checkpoint === undefined) {
    throw runtimeError("Checkpoint not found", "runtime_interrupt_not_found", {
      details: { checkpoint_id: input.checkpoint_id, thread_id: input.thread_id }
    });
  }
  if (checkpoint.metadata.workflow_revision !== input.workflow.revision) {
    throw runtimeError(
      "Checkpoint workflow revision is incompatible",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          expected: input.workflow.revision,
          actual: checkpoint.metadata.workflow_revision
        }
      }
    );
  }
  if (checkpoint.state_schema_version !== input.compiled.state_schema_version) {
    throw runtimeError(
      "Checkpoint state schema is incompatible with compiled workflow",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          expected: input.compiled.state_schema_version,
          actual: checkpoint.state_schema_version
        }
      }
    );
  }

  const resumeNodeId = String(checkpoint.metadata.resume_node_id ?? "");
  const resumeIndex = input.compiled.nodes.findIndex(
    (node) => node.id === resumeNodeId
  );
  if (resumeIndex < 0) {
    throw runtimeError("Resume node is not part of compiled workflow", "runtime_state_invalid", {
      details: { resume_node_id: resumeNodeId }
    });
  }
  assertSupportedRuntimeRequirements(input, resumeIndex + 1);

  const resumeContext = resumeContextFromMetadata(checkpoint.metadata);
  let state = createInitialRuntimeState({
    invocation: resumeContext.invocation,
    config: resumeContext.config,
    run: resumeContext.run,
    workflow: { id: input.workflow.id, mode: input.workflow.mode }
  });
  const priorWrites = await input.backends.checkpoints.listWrites(
    input.thread_id,
    checkpoint.checkpoint_ns,
    input.checkpoint_id
  );
  state = {
    ...state,
    steps: Object.fromEntries(
      priorWrites
        .filter((write) => write.channel === "steps")
        .map((write) => [write.task_id, write.value])
    )
  };
  const resumeNode = input.compiled.nodes[resumeIndex];
  assertOutputMatchesSchema(resumeNode, input.decision);
  const existingDecision = state.steps[resumeNodeId];
  const decisionAlreadyApplied = Object.prototype.hasOwnProperty.call(
    state.steps,
    resumeNodeId
  );
  if (
    decisionAlreadyApplied &&
    stableJson(existingDecision) !== stableJson(input.decision)
  ) {
    throw runtimeError(
      "Checkpoint resume decision conflicts with an already-applied decision",
      "interrupt_conflict",
      { details: { interrupt_id: input.interrupt_id, node_id: resumeNodeId } }
    );
  }
  await resumeInterrupt(
    {
      interrupt_id: input.interrupt_id,
      thread_id: input.thread_id,
      checkpoint_id: input.checkpoint_id,
      decision: input.decision
    },
    {
      interruptStore: input.backends.interrupts,
      eventStore: input.backends.events,
      resumeId: () => `resume-${input.interrupt_id}`
    }
  );
  if (!decisionAlreadyApplied) {
    await input.backends.checkpoints.saveWrites([
      {
        thread_id: input.thread_id,
        checkpoint_ns: checkpoint.checkpoint_ns,
        checkpoint_id: input.checkpoint_id,
        task_id: resumeNodeId,
        index: priorWrites.length,
        channel: "steps",
        value: input.decision
      }
    ]);
  }
  state = startNodeAttempt(state, resumeNodeId, 1);
  if (!decisionAlreadyApplied) {
    state = publishNodeOutput(state, resumeNodeId, input.decision);
  }
  state = succeedNode(state, resumeNodeId);

  return await runFromNodeIndex(
    {
      ...input,
      run: resumeContext.run,
      invocation: resumeContext.invocation,
      config: resumeContext.config
    },
    state,
    resumeIndex + 1
  );
}

function assertCompiledWorkflowMatchesDefinition(input: {
  readonly compiled: CompiledWorkflow;
  readonly workflow: WorkflowDefinition;
}): void {
  if (
    input.compiled.workflow_id !== input.workflow.id ||
    input.compiled.workflow_revision !== input.workflow.revision ||
    input.compiled.state_schema_version !== LUNA_RUNTIME_STATE_SCHEMA_VERSION
  ) {
    throw runtimeError(
      "Compiled workflow does not match the workflow definition",
      "runtime_state_invalid",
      {
        details: {
          compiled_workflow_id: input.compiled.workflow_id,
          workflow_id: input.workflow.id,
          compiled_workflow_revision: input.compiled.workflow_revision,
          workflow_revision: input.workflow.revision,
          compiled_state_schema_version: input.compiled.state_schema_version,
          runtime_state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION
        }
      }
    );
  }
}

function assertSupportedExecutionSubset(input: {
  readonly compiled: CompiledWorkflow;
  readonly workflow: WorkflowDefinition;
}): void {
  if (
    !Number.isSafeInteger(input.workflow.execution.max_concurrency) ||
    input.workflow.execution.max_concurrency < 1
  ) {
    throw runtimeError(
      "Workflow runner requires max_concurrency to be a positive integer",
      "runtime_unsupported_feature",
      {
        details: {
          workflow_id: input.workflow.id,
          max_concurrency: input.workflow.execution.max_concurrency
        }
      }
    );
  }
}

function assertSupportedRuntimeRequirements(input: {
  readonly compiled: CompiledWorkflow;
  readonly agentRuntime: AgentRuntimePort;
  readonly agentInputs?: WorkflowAgentInputMap;
}, startIndex: number): void {
  const agentNodes = input.compiled.nodes.slice(startIndex).filter(
    (node) => node.kind === "agent" && node.source.type === "agent"
  );
  const patternAgentInputs = Object.entries(input.agentInputs ?? {}).filter(
    ([key]) => key.includes(":worker") || key.includes(":gate:")
  );
  if (agentNodes.length === 0 && patternAgentInputs.length === 0) {
    return;
  }

  const supported = new Set(input.agentRuntime.describe().supported_runtime_requirements);
  for (const node of agentNodes) {
    if (node.kind !== "agent" || node.source.type !== "agent") {
      continue;
    }

    const requirements = runtimeRequirementsForNode(node, input.agentInputs?.[node.id]);
    const unsupported = requirements.filter(
      (requirement) => !supported.has(requirement)
    );
    if (unsupported.length > 0) {
      throw runtimeError("Agent runtime requirements are unsupported", "runtime_state_invalid", {
        details: { node_id: node.id, unsupported }
      });
    }
  }

  for (const [key, defaults] of patternAgentInputs) {
    const unsupported = runtimeRequirementsForDefaults(defaults).filter(
      (requirement) => !supported.has(requirement)
    );
    if (unsupported.length > 0) {
      throw runtimeError("Agent runtime requirements are unsupported", "runtime_state_invalid", {
        details: { agent_input_key: key, unsupported }
      });
    }
  }
}

async function runFromNodeIndex(
  input: RunCompiledWorkflowInput,
  initialState: LunaRuntimeState,
  startIndex: number
): Promise<WorkflowRunResult> {
  const runtimeContext = { ...(input.runtimeContext ?? {}) };
  rehydrateRuntimeContextFromSteps({
    nodes: input.compiled.nodes,
    steps: initialState.steps,
    runtimeContext,
    decisionForNode: (node) => executionPolicyDecisionForCompiledNode(input, node)
  });
  const nodes = input.compiled.nodes.slice(startIndex);
  const deferredFinalReportIds = deferredFinalReportNodeIds(input, nodes);
  const graph = compileLangGraphWorkflow({
    input,
    nodes,
    startIndex,
    runtimeContext,
    deferredFinalReportIds
  });

  let state: LunaRuntimeState;
  try {
    state = await graph.invoke(initialState, {
      configurable: { thread_id: input.run.run_id }
    }) as LunaRuntimeState;
  } catch (cause) {
    if (cause instanceof WorkflowWaitingForInput) {
      return cause.result;
    }

    throw cause;
  }

  const output = finalWorkflowOutput(input.compiled, state, deferredFinalReportIds);
  if (!matchesJsonSchema(input.workflow.output_schema_content as JsonSchemaLike, output)) {
    throw runtimeError("Final workflow output failed schema validation", "runtime_node_output_schema_invalid", {
      details: { workflow_id: input.workflow.id }
    });
  }

  const succeededState = { ...state, run_status: "succeeded" as const };
  await appendEvent(input, "run.succeeded");
  return { status: "succeeded", output, state: succeededState };
}

function compileLangGraphWorkflow({
  input,
  nodes,
  startIndex,
  runtimeContext,
  deferredFinalReportIds
}: {
  readonly input: RunCompiledWorkflowInput;
  readonly nodes: readonly CompiledWorkflowNode[];
  readonly startIndex: number;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly deferredFinalReportIds: ReadonlySet<string>;
}) {
  const graph = new StateGraph(WorkflowStateAnnotation) as unknown as DynamicStateGraph;

  for (const node of nodes) {
    graph.addNode(node.id, async (state: WorkflowGraphState) =>
      await runLangGraphNode({
        input,
        state: state as LunaRuntimeState,
        runtimeContext,
        node
      })
    );
  }

  for (const edge of langGraphEdges(input, nodes, startIndex, deferredFinalReportIds)) {
    graph.addEdge(
      edge.from === "__start__" ? START : edge.from,
      edge.to === "__end__" ? END : edge.to
    );
  }

  return graph.compile({
    name: input.workflow.id,
    ...(input.langGraphCheckpointer === undefined
      ? {}
      : { checkpointer: input.langGraphCheckpointer })
  });
}

async function runLangGraphNode({
  input,
  state,
  runtimeContext,
  node
}: {
  readonly input: RunCompiledWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly node: CompiledWorkflowNode;
}): Promise<WorkflowGraphUpdate> {
  const started = startNodeAttempt(state, node.id, 1);
  await appendEvent(input, "node.started", node.id);

  if (node.kind === "interrupt") {
    const waiting = await waitForHumanInput(input, started, node);
    throw new WorkflowWaitingForInput({
      status: "waiting_for_input",
      interrupt_id: interruptId(input.run.run_id, node.id),
      checkpoint_id: checkpointId(input.run.run_id, node.id),
      state: waiting
    });
  }

  const decision = executionPolicyDecisionForCompiledNode(input, node);
  const output = await withWorkflowLocks({
    decision,
    lockManager: input.lockManager,
    runtimeContext,
    run: async () =>
      await executeNode(
        input,
        started,
        runtimeContextSnapshot(runtimeContext),
        node
      )
  });

  assertOutputMatchesSchema(node, output);
  assertCheckpointJsonValue(output as JsonValue);
  await input.backends.checkpoints.saveWrites([
    {
      thread_id: input.run.run_id,
      checkpoint_ns: "",
      checkpoint_id: `node-output-${input.run.run_id}-${node.id}`,
      task_id: node.id,
      index: 0,
      channel: "steps",
      value: output as JsonValue
    }
  ]);

  const published = publishNodeOutput(started, node.id, output as JsonValue);
  promoteWorkspaceOutput(runtimeContext, decision, output);
  const succeeded = succeedNode(published, node.id);
  await appendEvent(input, "node.succeeded", node.id);

  return {
    node_statuses: { [node.id]: succeeded.node_statuses[node.id] },
    attempts: { [node.id]: succeeded.attempts[node.id] },
    steps: { [node.id]: output as JsonValue }
  };
}

function deferredFinalReportNodeIds(
  input: RunCompiledWorkflowInput,
  nodes: readonly CompiledWorkflowNode[]
): ReadonlySet<string> {
  const { deferredNodes } = splitDeferredFinalReportNodesByPolicy({
    nodes: nodes.map(policyNode),
    builtInMetadata: (node) => builtInMetadataForPolicyNode(input, node)
  });

  return new Set(deferredNodes.map((node) => node.id));
}

function runnableReadyNodes(
  nodes: readonly CompiledWorkflowNode[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  pending: ReadonlySet<string>,
  completed: ReadonlySet<string>,
  deferredFinalReportIds: ReadonlySet<string>
): CompiledWorkflowNode[] {
  const ready = readyNodes(nodes, dependencies, pending, completed);
  const hasPendingMainNodes = [...pending].some(
    (nodeId) => !deferredFinalReportIds.has(nodeId)
  );

  return hasPendingMainNodes
    ? ready.filter((node) => !deferredFinalReportIds.has(node.id))
    : ready;
}

function langGraphEdges(
  input: RunCompiledWorkflowInput,
  nodes: readonly CompiledWorkflowNode[],
  startIndex: number,
  deferredFinalReportIds: ReadonlySet<string>
): LangGraphEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const mainNodeIds = new Set(
    nodes
      .filter((node) => !deferredFinalReportIds.has(node.id))
      .map((node) => node.id)
  );
  const edges = new Map<string, LangGraphEdge>();

  const addEdge = (from: string, to: string): void => {
    if ((from === "__start__" || nodeIds.has(from)) && (to === "__end__" || nodeIds.has(to))) {
      edges.set(`${from}->${to}`, { from, to });
    }
  };

  for (const edge of input.compiled.edges) {
    if (deferredFinalReportIds.has(edge.to) && mainNodeIds.size > 0) {
      continue;
    }

    addEdge(edge.from, edge.to);
  }

  if (deferredFinalReportIds.size > 0 && mainNodeIds.size > 0) {
    const mainTerminalIds = terminalNodeIds([...mainNodeIds], input.compiled.edges);
    for (const mainNodeId of mainTerminalIds) {
      for (const deferredNodeId of deferredFinalReportIds) {
        addEdge(mainNodeId, deferredNodeId);
      }
    }
  }

  const policyEdges = policyConcurrencyEdges(input, nodes, startIndex, deferredFinalReportIds);
  for (const delayedNodeId of policyEdges.delayedNodeIds) {
    for (const key of [...edges.keys()]) {
      if (edges.get(key)?.to === delayedNodeId) {
        edges.delete(key);
      }
    }
  }
  for (const edge of policyEdges.edges) {
    addEdge(edge.from, edge.to);
  }

  for (const node of nodes) {
    const hasIncoming = [...edges.values()].some((edge) => edge.to === node.id);
    if (!hasIncoming) {
      addEdge("__start__", node.id);
    }
  }

  return [...edges.values()];
}

function terminalNodeIds(
  nodeIds: readonly string[],
  edges: readonly LangGraphEdge[]
): string[] {
  const nodeIdSet = new Set(nodeIds);
  const nonTerminal = new Set(
    edges
      .filter((edge) => nodeIdSet.has(edge.from) && nodeIdSet.has(edge.to))
      .map((edge) => edge.from)
  );

  return nodeIds.filter((nodeId) => !nonTerminal.has(nodeId));
}

function policyConcurrencyEdges(
  input: RunCompiledWorkflowInput,
  nodes: readonly CompiledWorkflowNode[],
  startIndex: number,
  deferredFinalReportIds: ReadonlySet<string>
): PolicyEdgePlan {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const dependencies = dependenciesByNode(input.compiled, nodeIds);
  const pending = new Set(nodes.map((node) => node.id));
  const completed = new Set(input.compiled.nodes.slice(0, startIndex).map((node) => node.id));
  const edges: LangGraphEdge[] = [];
  const delayedNodeIds = new Set<string>();

  while (pending.size > 0) {
    const ready = runnableReadyNodes(
      nodes,
      dependencies,
      pending,
      completed,
      deferredFinalReportIds
    );
    if (ready.length === 0) {
      throw runtimeError("Workflow graph has no runnable nodes", "runtime_state_invalid", {
        details: {
          workflow_id: input.workflow.id,
          pending: [...pending]
        }
      });
    }

    const batch = selectReadyBatchWithPolicy({
      ready: ready.map(policyNode),
      maxConcurrency: input.workflow.execution.max_concurrency,
      builtInMetadata: (node) => builtInMetadataForPolicyNode(input, node)
    }).items.map((item) => item.node.compiled);
    if (batch.length === 0) {
      throw runtimeError("Workflow execution policy selected no runnable nodes", "runtime_state_invalid", {
        details: { workflow_id: input.workflow.id, pending: [...pending] }
      });
    }

    const blockedReady = ready.filter(
      (node) => !batch.some((batchNode) => batchNode.id === node.id)
    );
    for (const blocked of blockedReady) {
      delayedNodeIds.add(blocked.id);
      for (const running of batch) {
        edges.push({ from: running.id, to: blocked.id });
      }
    }

    for (const node of batch) {
      pending.delete(node.id);
      completed.add(node.id);
    }
  }

  return { edges, delayedNodeIds };
}

function policyNode(node: CompiledWorkflowNode): RunnerPolicyNode {
  return {
    id: node.id,
    type: policyNodeType(node),
    after: afterFromCompiledNode(node),
    artifacts: node.source.type === "built_in" ||
      node.source.type === "agent" ||
      node.source.type === "pattern" ||
      node.source.type === "human_gate"
      ? node.source.artifacts
      : undefined,
    ...(node.source.type === "built_in" ? { uses: node.source.uses } : {}),
    compiled: node
  };
}

function policyNodeType(
  node: CompiledWorkflowNode
): WorkflowExecutionNode["type"] {
  if (node.kind === "agent") {
    return "agent";
  }
  if (node.kind === "pattern") {
    return "gated_agent_loop";
  }

  return "built_in";
}

function afterFromCompiledNode(node: CompiledWorkflowNode): string[] | undefined {
  return node.source.type === "built_in" ||
    node.source.type === "agent" ||
    node.source.type === "pattern" ||
    node.source.type === "human_gate"
    ? [...(node.source.after ?? [])]
    : undefined;
}

function builtInMetadataForPolicyNode(
  input: RunCompiledWorkflowInput,
  node: RunnerPolicyNode
): BuiltInStepMetadata {
  return input.builtInMetadata?.(node.compiled) ?? {};
}

function executionPolicyDecisionForCompiledNode(
  input: RunCompiledWorkflowInput,
  node: CompiledWorkflowNode
): ExecutionPolicyDecision {
  return selectReadyBatchWithPolicy({
    ready: [policyNode(node)],
    maxConcurrency: 1,
    builtInMetadata: (candidate) => builtInMetadataForPolicyNode(input, candidate)
  }).items[0].decision;
}

async function executeNode(
  input: RunCompiledWorkflowInput,
  state: LunaRuntimeState,
  runtimeContext: WorkflowRuntimeContext,
  node: CompiledWorkflowNode
): Promise<unknown> {
  if (node.kind === "built_in" || node.kind === "pattern") {
    const nodeInput = await resolveNodeInput(node, state, runtimeContext, input);
    if (node.kind === "pattern" && node.capability_id === "quality-gates.gated_agent_loop") {
      return await executeGatedAgentLoopNode({
        input,
        state,
        runtimeContext,
        node,
        nodeInput
      });
    }

    const executor = input.builtIns[node.capability_id];
    if (executor === undefined) {
      throw runtimeError("No executor registered for workflow node", "runtime_state_invalid", {
        details: { node_id: node.id, capability_id: node.capability_id }
      });
    }

    return await executor({
      node,
      input: nodeInput,
      state,
      runtimeContext,
      workflow: input.workflow
    });
  }

  if (node.kind === "agent") {
    const source = node.source;
    if (source.type !== "agent") {
      throw runtimeError("Compiled agent node source is invalid", "runtime_state_invalid", {
        details: { node_id: node.id }
      });
    }

    const defaults = requireAgentDefaults(input, node);
    const requirements = runtimeRequirementsForNode(node, defaults);
    const agentInput: RunAgentInput = {
      run: input.run,
      node_id: node.id,
      agent_id: source.agent,
      agent_mode: input.workflow.mode,
      instructions: defaults.instructions,
      input: await resolveNodeInput(node, state, runtimeContext, input),
      output_schema: node.output_schema,
      model_profile: defaults.model_profile,
      tools: defaults.tools,
      context: defaults.context,
      ...(defaults.cwd === undefined ? {} : { cwd: defaults.cwd }),
      runtime_requirements: requirements,
      signal: defaults.signal,
      events: defaults.events
    };

    await input.agentRuntime.validate(agentInput);
    const result = await input.agentRuntime.runAgent(agentInput);
    return result.output;
  }

  throw runtimeError("Unsupported compiled node kind", "runtime_state_invalid", {
    details: { node_id: node.id, kind: node.kind }
  });
}

async function waitForHumanInput(
  input: RunCompiledWorkflowInput,
  state: LunaRuntimeState,
  node: CompiledWorkflowNode
): Promise<LunaRuntimeState> {
  const id = interruptId(input.run.run_id, node.id);
  const checkpoint_id = checkpointId(input.run.run_id, node.id);
  const waiting = markNodeWaitingForInput(state, node.id);
  await input.backends.checkpoints.saveWrites(
    Object.entries(state.steps).map(([nodeId, value], index) => ({
      thread_id: input.run.run_id,
      checkpoint_ns: "",
      checkpoint_id,
      task_id: nodeId,
      index,
      channel: "steps",
      value
    }))
  );
  await input.backends.checkpoints.save({
    thread_id: input.run.run_id,
    checkpoint_id,
    state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
    state: {
      state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
      run_status: "waiting_for_input",
      interrupt_refs: [{ id, uri: `interrupt://${input.run.run_id}/${node.id}`, node_id: node.id }]
    },
    metadata: {
      workflow_revision: input.workflow.revision,
      resume_node_id: node.id,
      resume_context: checkpointResumeContext(input)
    }
  });
  await createInterrupt(
    {
      interrupt_id: id,
      run: input.run,
      checkpoint_id,
      node_id: node.id,
      kind: node.capability_id,
      prompt: "",
      decisions: [],
      created_at: new Date().toISOString()
    },
    {
      threadId: input.run.run_id,
      interruptStore: input.backends.interrupts,
      eventStore: input.backends.events
    }
  );

  return {
    ...waiting,
    interrupt_refs: [{ id, uri: `interrupt://${input.run.run_id}/${node.id}`, node_id: node.id }]
  };
}

function requireAgentDefaults(
  input: RunCompiledWorkflowInput,
  node: CompiledWorkflowNode
): WorkflowAgentDefaults {
  const defaults = input.agentInputs?.[node.id];
  if (defaults === undefined) {
    throw runtimeError("Agent node requires projected runtime input", "runtime_state_invalid", {
      details: { node_id: node.id, agent_id: node.source.type === "agent" ? node.source.agent : undefined }
    });
  }

  return defaults;
}

function checkpointResumeContext(input: RunCompiledWorkflowInput): JsonObject {
  const context = {
    invocation: input.invocation,
    config: input.config,
    run: input.run as unknown as JsonValue
  };
  assertCheckpointJsonValue(context);

  return context;
}

function resumeContextFromMetadata(metadata: JsonObject): {
  readonly invocation: JsonValue;
  readonly config: JsonValue;
  readonly run: RunHandle;
} {
  const context = metadata.resume_context;
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    throw runtimeError("Checkpoint is missing resume context", "runtime_checkpoint_schema_mismatch");
  }

  const invocation = context.invocation;
  const config = context.config;
  const run = context.run;
  if (
    typeof run !== "object" ||
    run === null ||
    Array.isArray(run) ||
    typeof run.run_id !== "string" ||
    typeof run.workflow_id !== "string" ||
    typeof run.attempt !== "number" ||
    typeof run.started_at !== "string"
  ) {
    throw runtimeError("Checkpoint resume run handle is invalid", "runtime_checkpoint_schema_mismatch");
  }

  return { invocation, config, run: run as unknown as RunHandle };
}

function assertOutputMatchesSchema(
  node: CompiledWorkflowNode,
  output: unknown
): void {
  if (!matchesJsonSchema(node.output_schema as JsonSchemaLike, output)) {
    throw runtimeError("Node output failed schema validation", "runtime_node_output_schema_invalid", {
      details: { node_id: node.id, yaml_path: node.yaml_path, capability: node.capability_id }
    });
  }
}

function runtimeRequirementsForNode(
  node: CompiledWorkflowNode,
  projectedInput?: WorkflowAgentDefaults
): AgentRuntimeRequirement[] {
  const sourceRequirements =
    node.source.type === "agent"
      ? ((node.source.runtime_requirements ?? []) as AgentRuntimeRequirement[])
      : [];
  const agentRequirements = projectedInput?.runtime_requirements ?? [];
  const toolRequirements = projectedInput?.tools.runtime_requirements ?? [];

  return [...new Set([...sourceRequirements, ...agentRequirements, ...toolRequirements])];
}

function runtimeRequirementsForDefaults(
  projectedInput: WorkflowAgentDefaults
): AgentRuntimeRequirement[] {
  return [
    ...new Set([
      ...(projectedInput.runtime_requirements ?? []),
      ...projectedInput.tools.runtime_requirements
    ])
  ] as AgentRuntimeRequirement[];
}

async function appendEvent(
  input: Pick<RunCompiledWorkflowInput, "backends" | "run">,
  type: string,
  nodeId?: string,
  interruptIdValue?: string
): Promise<void> {
  await input.backends.events.append({
    id: `${input.run.run_id}:${type}:${nodeId ?? "run"}:${Date.now()}`,
    run_id: input.run.run_id,
    type,
    timestamp: new Date().toISOString(),
    ...(nodeId === undefined ? {} : { node_id: nodeId }),
    ...(interruptIdValue === undefined ? {} : { interrupt_id: interruptIdValue })
  });
}

function interruptId(runId: string, nodeId: string): string {
  return `interrupt-${runId}-${nodeId}`;
}

function checkpointId(runId: string, nodeId: string): string {
  return `checkpoint-${runId}-${nodeId}`;
}
