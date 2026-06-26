import jsonata from "jsonata";
import type {
  AgentRuntimePort,
  AgentRuntimeRequirement,
  AgentRuntimeEventSink,
  RunAgentInput
} from "../agent-runtime/contracts.js";
import type { ModelProfile } from "../config/schemas.js";
import { matchesJsonSchema } from "../capabilities/json-schema.js";
import type { JsonSchemaLike } from "../capabilities/pattern-registration.js";
import type { RuntimeBackends } from "../runtime/backends/contracts.js";
import type { ResolvedToolCatalog } from "../tools/resolved-catalog.js";
import { runtimeError } from "../runtime/errors.js";
import {
  assertCheckpointJsonValue,
  stableJson,
  type JsonObject,
  type JsonValue
} from "../runtime/json.js";
import type { RunHandle } from "../runtime/run-handle.js";
import {
  LUNA_RUNTIME_STATE_SCHEMA_VERSION,
  createInitialRuntimeState,
  publishNodeOutput,
  type LunaRuntimeState
} from "../runtime/state.js";
import {
  markNodeWaitingForInput,
  startNodeAttempt,
  succeedNode
} from "../runtime/lifecycle.js";
import {
  createInterrupt,
  resumeInterrupt
} from "../runtime/interrupts/resume.js";
import type { WorkflowDefinition } from "./definition-types.js";
import {
  isExpressionObject,
  WorkflowExpressionError
} from "./expression.js";
import type {
  CompiledWorkflow,
  CompiledWorkflowNode
} from "./compiler.js";

export type WorkflowBuiltInExecutor = (input: {
  readonly node: CompiledWorkflowNode;
  readonly input: unknown;
  readonly state: LunaRuntimeState;
  readonly workflow: WorkflowDefinition;
}) => Promise<unknown> | unknown;

export type RunCompiledWorkflowInput = {
  readonly compiled: CompiledWorkflow;
  readonly workflow: WorkflowDefinition;
  readonly invocation: JsonValue;
  readonly config: JsonValue;
  readonly run: RunHandle;
  readonly backends: RuntimeBackends;
  readonly builtIns: Record<string, WorkflowBuiltInExecutor>;
  readonly agentRuntime: AgentRuntimePort;
  readonly agentInputs?: WorkflowAgentInputMap;
};

export type ResumeCompiledWorkflowInput = Omit<
  RunCompiledWorkflowInput,
  "invocation" | "config" | "run"
> & {
  readonly thread_id: string;
  readonly checkpoint_id: string;
  readonly interrupt_id: string;
  readonly decision: JsonValue;
};

export type WorkflowAgentDefaults = {
  readonly instructions: string;
  readonly model_profile: ModelProfile;
  readonly tools: ResolvedToolCatalog;
  readonly context: unknown;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly events?: AgentRuntimeEventSink;
};

export type WorkflowAgentInputMap = Readonly<Record<string, WorkflowAgentDefaults>>;

export type WorkflowRunResult =
  | {
      readonly status: "succeeded";
      readonly output: JsonValue;
      readonly state: LunaRuntimeState;
    }
  | {
      readonly status: "waiting_for_input";
      readonly interrupt_id: string;
      readonly checkpoint_id: string;
      readonly state: LunaRuntimeState;
    };

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
  if (input.workflow.execution.max_concurrency !== 1) {
    throw runtimeError(
      "Workflow runner currently supports only max_concurrency: 1",
      "runtime_unsupported_feature",
      {
        details: {
          workflow_id: input.workflow.id,
          max_concurrency: input.workflow.execution.max_concurrency
        }
      }
    );
  }

  const nodeIds = new Set(input.compiled.nodes.map((node) => node.id));
  const startEdges = input.compiled.edges.filter((edge) => edge.from === "__start__");
  const endEdges = input.compiled.edges.filter((edge) => edge.to === "__end__");
  const graphEdges = input.compiled.edges.filter(
    (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)
  );
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of graphEdges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
  }

  const isLinear =
    startEdges.length <= 1 &&
    endEdges.length <= 1 &&
    [...incoming.values()].every((count) => count <= 1) &&
    [...outgoing.values()].every((count) => count <= 1);

  if (!isLinear) {
    throw runtimeError(
      "Workflow runner currently supports only linear compiled workflow graphs",
      "runtime_unsupported_feature",
      { details: { workflow_id: input.workflow.id } }
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
  if (agentNodes.length === 0) {
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
}

async function runFromNodeIndex(
  input: RunCompiledWorkflowInput,
  initialState: LunaRuntimeState,
  startIndex: number
): Promise<WorkflowRunResult> {
  let state = initialState;

  for (let index = startIndex; index < input.compiled.nodes.length; index += 1) {
    const node = input.compiled.nodes[index];
    state = startNodeAttempt(state, node.id, 1);
    await appendEvent(input, "node.started", node.id);

    if (node.kind === "interrupt") {
      state = await waitForHumanInput(input, state, node);
      return {
        status: "waiting_for_input",
        interrupt_id: interruptId(input.run.run_id, node.id),
        checkpoint_id: checkpointId(input.run.run_id, node.id),
        state
      };
    }

    const output = await executeNode(input, state, node);
    assertOutputMatchesSchema(node, output);
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
    state = publishNodeOutput(state, node.id, output as JsonValue);
    state = succeedNode(state, node.id);
    await appendEvent(input, "node.succeeded", node.id);
  }

  const output = finalOutput(input.compiled, state);
  if (!matchesJsonSchema(input.workflow.output_schema_content as JsonSchemaLike, output)) {
    throw runtimeError("Final workflow output failed schema validation", "runtime_node_output_schema_invalid", {
      details: { workflow_id: input.workflow.id }
    });
  }

  const succeededState = { ...state, run_status: "succeeded" as const };
  await appendEvent(input, "run.succeeded");
  return { status: "succeeded", output, state: succeededState };
}

async function executeNode(
  input: RunCompiledWorkflowInput,
  state: LunaRuntimeState,
  node: CompiledWorkflowNode
): Promise<unknown> {
  if (node.kind === "built_in" || node.kind === "pattern") {
    const executor = input.builtIns[node.capability_id];
    if (executor === undefined) {
      throw runtimeError("No executor registered for workflow node", "runtime_state_invalid", {
        details: { node_id: node.id, capability_id: node.capability_id }
      });
    }

    return await executor({
      node,
      input: await resolveNodeInput(node, state, input),
      state,
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
      input: await resolveNodeInput(node, state, input),
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

async function resolveNodeInput(
  node: CompiledWorkflowNode,
  state: LunaRuntimeState,
  input: RunCompiledWorkflowInput
): Promise<unknown> {
  const sourceInput =
    node.source.type === "agent" ||
    node.source.type === "built_in" ||
    node.source.type === "pattern"
      ? node.source.input ?? {}
      : {};

  return await resolveRuntimeValue(sourceInput, {
    root: {
      invocation: input.invocation,
      config: input.config,
      run: input.run,
      steps: state.steps
    },
    path: `${node.yaml_path}.input`,
    capability: node.capability_id
  });
}

async function resolveRuntimeValue(
  value: unknown,
  context: { root: unknown; path: string; capability: string }
): Promise<unknown> {
  if (isExpressionObject(value)) {
    try {
      const evaluated = await jsonata(value.expression).evaluate(context.root);
      if (evaluated === undefined) {
        throw new WorkflowExpressionError(
          "workflow_expression_unresolved",
          `Expression at ${context.path} for ${context.capability} resolved to undefined.`,
          { path: context.path, capability: context.capability }
        );
      }

      return evaluated;
    } catch (cause) {
      if (cause instanceof WorkflowExpressionError) {
        throw cause;
      }

      throw new WorkflowExpressionError(
        "workflow_expression_invalid",
        `Expression at ${context.path} for ${context.capability} failed during runtime evaluation.`,
        { path: context.path, capability: context.capability }
      );
    }
  }

  if (Array.isArray(value)) {
    return await Promise.all(
      value.map((item, index) =>
        resolveRuntimeValue(item, {
          ...context,
          path: `${context.path}[${index}]`
        })
      )
    );
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, nested]) => [
          key,
          await resolveRuntimeValue(nested, {
            ...context,
            path: `${context.path}.${key}`
          })
        ])
      )
    );
  }

  return value;
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
  const toolRequirements = projectedInput?.tools.runtime_requirements ?? [];

  return [...new Set([...sourceRequirements, ...toolRequirements])];
}

function finalOutput(
  compiled: CompiledWorkflow,
  state: LunaRuntimeState
): JsonValue {
  const finalNode = compiled.nodes.at(-1);
  if (finalNode === undefined) {
    return {};
  }

  return state.steps[finalNode.id] ?? {};
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
