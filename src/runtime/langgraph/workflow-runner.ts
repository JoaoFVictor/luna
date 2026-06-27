import type { AgentRuntimePort } from "../../core/agent-runtime/contracts.js";
import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../core/capabilities/pattern-registration.js";
import type { JsonObject } from "../../core/runtime/backends/contracts.js";
import { runtimeError } from "../../core/runtime/errors.js";
import {
  stableJson,
  type JsonValue
} from "../../core/runtime/json.js";
import type {
  WorkflowRuntimeFactory,
  WorkflowRuntimeFactoryContext,
  WorkflowRuntimeRunner
} from "../../core/workflow/runner-port.js";
import { sqliteCheckpointBackendRegistration } from "../backends/sqlite/checkpoints.js";
import { LunaLangGraphCheckpointer } from "../backends/sqlite/langgraph-checkpointer.js";
import {
  LUNA_RUNTIME_STATE_SCHEMA_VERSION,
  createInitialRuntimeState,
  publishNodeOutput,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import {
  startNodeAttempt,
  succeedNode
} from "../../core/runtime/lifecycle.js";
import { resumeInterrupt } from "../../core/runtime/interrupts/resume.js";
import {
  selectReadyBatchWithPolicy,
  splitDeferredFinalReportNodesByPolicy,
  type ExecutionPolicyDecision
} from "../../core/workflow/execution-policy.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";
import { finalWorkflowOutput } from "../../core/workflow/runner-output.js";
import {
  withWorkflowLocks
} from "../../core/workflow/runner-locks.js";
import { writeSummaryBestEffort } from "../../core/observability/summary.js";
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
  type WorkflowGraphUpdate
} from "./workflow-state.js";
import { publishArtifactsForNode } from "./workflow-artifacts.js";
import {
  builtInMetadataForPolicyNode,
  policyNode
} from "./workflow-edges.js";
import { appendWorkflowEvent as appendEvent } from "./workflow-events.js";
import {
  runtimeRequirementsForDefaults,
  runtimeRequirementsForNode
} from "./workflow-agent-bridge.js";
import {
  saveNodeOutputWrite,
  saveTerminalCheckpoint,
  terminalCheckpointSnapshot
} from "./workflow-checkpoints.js";
import { compileLangGraphWorkflow } from "./workflow-graph.js";
import {
  checkpointId,
  interruptId,
  resumeContextFromMetadata,
  waitForHumanInput
} from "./workflow-interrupts.js";
import { executeNode } from "./workflow-node-executor.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput
} from "../../core/workflow/execution-contracts.js";
import type {
  ResumeCompiledWorkflowInput,
  RunCompiledWorkflowInput,
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
  WorkflowPatternExecutor,
  WorkflowRunResult
} from "./workflow-runner-types.js";

export function createLangGraphWorkflowRuntimeRunner(): WorkflowRuntimeRunner<
  RunCompiledWorkflowInput,
  ResumeCompiledWorkflowInput,
  WorkflowRunResult
> {
  return {
    run: runCompiledWorkflow,
    resume: resumeCompiledWorkflow
  };
}

export const langGraphWorkflowRuntimeFactory = {
  id: "langgraph",
  create(options: JsonObject, context: WorkflowRuntimeFactoryContext) {
    if (Object.keys(options).length > 0) {
      throw runtimeError(
        "LangGraph workflow runtime options are not supported",
        "runtime_backend_invalid",
        { details: { workflow_runtime_id: "langgraph" } }
      );
    }

    const runner = createLangGraphWorkflowRuntimeRunner();
    return {
      run(input: RunWorkflowInput) {
        return runner.run(withLangGraphRuntimeExtensions(input, context));
      },
      resume(input: ResumeWorkflowInput) {
        return runner.resume(withLangGraphRuntimeExtensions(input, context));
      }
    };
  }
} satisfies WorkflowRuntimeFactory<
  RunWorkflowInput,
  ResumeWorkflowInput,
  WorkflowRunResult
>;

function withLangGraphRuntimeExtensions<TInput extends RunWorkflowInput | ResumeWorkflowInput>(
  input: TInput,
  context: WorkflowRuntimeFactoryContext
): TInput & { readonly langGraphCheckpointer?: RunCompiledWorkflowInput["langGraphCheckpointer"] } {
  if (context.checkpoints.backendId !== sqliteCheckpointBackendRegistration.id) {
    return input;
  }

  return {
    ...input,
    langGraphCheckpointer: new LunaLangGraphCheckpointer(context.checkpoints.store)
  };
}

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
    deferredFinalReportIds,
    runNode: async (node, state) =>
      await runLangGraphNode({
        input,
        state: state as LunaRuntimeState,
        runtimeContext,
        node
      })
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

    try {
      const latestCheckpoint = await input.backends.checkpoints.load(input.run.run_id);
      await saveTerminalCheckpoint({
        input,
        state: terminalCheckpointSnapshot(latestCheckpoint?.state ?? initialState, "failed")
      });
    } catch {
      // Preserve the original workflow failure; the run.failed event remains authoritative.
    }
    await appendEvent(input, "run.failed");
    await writeSummaryBestEffort(input.artifactPublisher, input.observabilitySummary);
    throw cause;
  }

  const output = finalWorkflowOutput(input.compiled, state, deferredFinalReportIds);
  if (!matchesJsonSchema(input.workflow.output_schema_content as JsonSchemaLike, output)) {
    throw runtimeError("Final workflow output failed schema validation", "runtime_node_output_schema_invalid", {
      details: { workflow_id: input.workflow.id }
    });
  }

  const succeededState = { ...state, run_status: "succeeded" as const };
  await saveTerminalCheckpoint({
    input,
    state: terminalCheckpointSnapshot(succeededState, "succeeded")
  });
  await appendEvent(input, "run.succeeded");
  await writeSummaryBestEffort(input.artifactPublisher, input.observabilitySummary);
  return { status: "succeeded", output, state: succeededState };
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
  let output: unknown;
  try {
    output = await withWorkflowLocks({
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
  } catch (cause) {
    await appendEvent(input, "node.failed", node.id);
    throw cause;
  }

  assertOutputMatchesSchema(node, output);
  await saveNodeOutputWrite({ input, node, output: output as JsonValue });

  const published = publishNodeOutput(started, node.id, output as JsonValue);
  const artifactRefs = await publishArtifactsForNode(input, node, output, started);
  const withArtifacts = artifactRefs.length === 0
    ? published
    : {
        ...published,
        artifact_refs: [
          ...published.artifact_refs,
          ...artifactRefs
        ]
      };
  promoteWorkspaceOutput(runtimeContext, decision, output);
  const succeeded = succeedNode(withArtifacts, node.id);
  await appendEvent(input, "node.succeeded", node.id);

  return {
    node_statuses: { [node.id]: succeeded.node_statuses[node.id] },
    attempts: { [node.id]: succeeded.attempts[node.id] },
    steps: { [node.id]: output as JsonValue },
    ...(artifactRefs.length === 0 ? {} : { artifact_refs: artifactRefs })
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
