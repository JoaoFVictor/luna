import type { AgentRuntimePort } from "../../core/agent-runtime/contracts.js";
import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../core/capabilities/json-schema-types.js";
import type { WorkflowRunResult } from "../../core/workflow/execution-contracts.js";
import { runtimeError } from "../../core/runtime/errors.js";
import { assertCheckpointJsonValue, stableJson, type JsonValue } from "../../core/runtime/json.js";
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
import {
  workflowExecutionPlanPolicyNode,
  type WorkflowExecutionPlanPolicyNode
} from "../../core/workflow/execution-plan.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";
import { finalWorkflowOutput } from "../../core/workflow/runner-output.js";
import { writeTraceSummaryBestEffort } from "../../core/observability/summary.js";
import type { BuiltInStepMetadata } from "../../core/built-ins/types.js";
import {
  assertNodeOutputMatchesSchema,
  runWorkflowNodeAttempt,
  type WorkflowNodeAttemptOutcome
} from "./node-runner.js";
import {
  runtimeRequirementsForDefaults,
  runtimeRequirementsForNode
} from "./agent-node-executor.js";
import {
  rehydrateRuntimeContextFromSteps
} from "../../core/workflow/runner-context.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";
import type {
  CompiledWorkflow,
  CompiledWorkflowNode
} from "../../core/workflow/compiler.js";
import {
  saveTerminalCheckpoint,
  terminalCheckpointSnapshot
} from "./checkpoints.js";
import {
  resumeContextFromMetadata
} from "./interrupts.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput,
  WorkflowAgentInputMap
} from "../../core/workflow/execution-contracts.js";
import { appendWorkflowEvent } from "../../core/workflow/events.js";

export type { WorkflowNodeAttemptOutcome } from "./node-runner.js";

export type WorkflowNodeSchedulerInput<TInput extends RunWorkflowInput> = {
  readonly input: TInput;
  readonly initialState: LunaRuntimeState;
  readonly nodes: readonly CompiledWorkflowNode[];
  readonly startIndex: number;
  readonly deferredFinalReportIds: ReadonlySet<string>;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly runNode: (
    node: CompiledWorkflowNode,
    state: LunaRuntimeState
  ) => Promise<WorkflowNodeAttemptOutcome>;
};

export type WorkflowNodeSchedulerResult =
  | {
      readonly kind: "completed";
      readonly state: LunaRuntimeState;
    }
  | {
      readonly kind: "waiting_for_input";
      readonly interrupt_id: string;
      readonly checkpoint_id: string;
      readonly state: LunaRuntimeState;
    };

export type WorkflowNodeScheduler<TInput extends RunWorkflowInput> = (
  input: WorkflowNodeSchedulerInput<TInput>
) => Promise<WorkflowNodeSchedulerResult>;

export async function runCompiledWorkflowWithScheduler<TInput extends RunWorkflowInput>(
  input: TInput,
  scheduler: WorkflowNodeScheduler<TInput>
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
  return await runWithWorkflowSpan(input, async () =>
    await runFromNodeIndex(input, scheduler, state, 0)
  );
}

export async function resumeCompiledWorkflowWithScheduler<TInput extends ResumeWorkflowInput>(
  input: TInput,
  scheduler: WorkflowNodeScheduler<RunWorkflowInput & TInput>
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
  assertNodeOutputMatchesSchema(resumeNode, input.decision);
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
  await input.observability?.recorder.addEvent("interrupt.resumed", {
    interrupt_id: input.interrupt_id,
    checkpoint_id: input.checkpoint_id,
    node_id: resumeNodeId
  });
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

  const resumedInput = {
    ...input,
    run: resumeContext.run,
    invocation: resumeContext.invocation,
    config: resumeContext.config
  };

  return await runWithWorkflowSpan(resumedInput, async () =>
    await runFromNodeIndex(
      resumedInput,
      scheduler,
      state,
      resumeIndex + 1
    )
  );
}

async function runWithWorkflowSpan<TInput extends RunWorkflowInput>(
  input: TInput,
  run: () => Promise<WorkflowRunResult>
): Promise<WorkflowRunResult> {
  if (input.observability === undefined) {
    return await run();
  }

  try {
    const result = await input.observability.recorder.withSpan(
      {
        name: "workflow.run",
        kind: "workflow",
        attributes: {
          "luna.workflow.id": input.workflow.id,
          "luna.workflow.mode": input.workflow.mode,
          "luna.workflow.revision": input.workflow.revision
        },
        metadata: {
          directory: input.workflow.directory,
          capabilities: input.workflow.capabilities
        }
      },
      async (span) => {
        const result = await run();
        if (result.status === "waiting_for_input") {
          span.setStatus("waiting");
          await span.addEvent("workflow.waiting_for_input", {
            interrupt_id: result.interrupt_id,
            checkpoint_id: result.checkpoint_id
          });
        }
        return result;
      }
    );
    return result;
  } finally {
    await input.observability.close();
    await writeTraceSummaryBestEffort(
      input.artifactPublisher,
      input.observability.snapshotSummary()
    );
  }
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

async function runFromNodeIndex<TInput extends RunWorkflowInput>(
  input: TInput,
  scheduler: WorkflowNodeScheduler<TInput>,
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
  let state: LunaRuntimeState;
  try {
    const result = await scheduler({
      input,
      initialState,
      nodes,
      startIndex,
      deferredFinalReportIds,
      runtimeContext,
      runNode: async (node, currentState) =>
        await runWorkflowNodeAttempt({
          input,
          state: currentState,
          runtimeContext,
          node,
          decision: executionPolicyDecisionForCompiledNode(input, node)
        })
    });
    if (result.kind === "waiting_for_input") {
      return {
        status: "waiting_for_input",
        interrupt_id: result.interrupt_id,
        checkpoint_id: result.checkpoint_id,
        state: result.state
      };
    }
    state = result.state;
  } catch (cause) {
    try {
      const latestCheckpoint = await input.backends.checkpoints.load(input.run.run_id);
      const failedState = (latestCheckpoint?.state ?? initialState) as LunaRuntimeState;
      const cleanedState = await completeWorkspaceLifecycle({
        input,
        state: failedState,
        runtimeContext,
        status: "failed"
      });
      await saveTerminalCheckpoint({
        input,
        state: terminalCheckpointSnapshot(cleanedState, "failed")
      });
    } catch {
      // Preserve the original workflow failure; the run.failed event remains authoritative.
    }
    await appendWorkflowEvent(input, "run.failed");
    throw cause;
  }

  state = await completeWorkspaceLifecycle({
    input,
    state,
    runtimeContext,
    status: "succeeded"
  });
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
  await appendWorkflowEvent(input, "run.succeeded");
  return { status: "succeeded", output, state: succeededState };
}

function deferredFinalReportNodeIds(
  input: RunWorkflowInput,
  nodes: readonly CompiledWorkflowNode[]
): ReadonlySet<string> {
  const { deferredNodes } = splitDeferredFinalReportNodesByPolicy({
    nodes: nodes.map(workflowExecutionPlanPolicyNode),
    builtInMetadata: (node) => builtInMetadataForPolicyNode(input, node)
  });

  return new Set(deferredNodes.map((node) => node.id));
}

function executionPolicyDecisionForCompiledNode(
  input: RunWorkflowInput,
  node: CompiledWorkflowNode
): ExecutionPolicyDecision {
  return selectReadyBatchWithPolicy({
    ready: [workflowExecutionPlanPolicyNode(node)],
    maxConcurrency: 1,
    builtInMetadata: (candidate) => builtInMetadataForPolicyNode(input, candidate)
  }).items[0].decision;
}

function builtInMetadataForPolicyNode(
  input: RunWorkflowInput,
  node: WorkflowExecutionPlanPolicyNode
): BuiltInStepMetadata {
  return input.builtInMetadata?.(node.compiled) ?? {};
}

async function completeWorkspaceLifecycle({
  input,
  state,
  runtimeContext,
  status
}: {
  readonly input: RunWorkflowInput;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly status: "succeeded" | "failed";
}): Promise<LunaRuntimeState> {
  if (input.workspaceLifecycle === undefined) {
    return state;
  }

  const previousWorkspace = runtimeContext.workspace;
  const completedWorkspace = await input.workspaceLifecycle.complete({
    status,
    state,
    runtimeContext
  });
  if (completedWorkspace === undefined) {
    return state;
  }

  runtimeContext.workspace = completedWorkspace;
  return replaceWorkspaceInState(state, previousWorkspace, completedWorkspace);
}

function replaceWorkspaceInState(
  state: LunaRuntimeState,
  previousWorkspace: unknown,
  completedWorkspace: unknown
): LunaRuntimeState {
  if (!isWorkspaceRecord(previousWorkspace) || !isWorkspaceRecord(completedWorkspace)) {
    return state;
  }

  const steps: Record<string, JsonValue> = {};
  for (const [nodeId, value] of Object.entries(state.steps)) {
    const nextValue = workspaceStepValue(
      value,
      previousWorkspace,
      completedWorkspace
    );
    assertCheckpointJsonValue(nextValue, `$.steps.${nodeId}`);
    steps[nodeId] = nextValue;
  }

  return { ...state, steps };
}

function workspaceStepValue(
  value: unknown,
  previousWorkspace: WorkspaceRecordLike,
  completedWorkspace: WorkspaceRecordLike
): unknown {
  if (sameWorkspaceIdentity(value, previousWorkspace)) {
    return completedWorkspace;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const candidate = value as { readonly workspace?: unknown };
  if (!sameWorkspaceIdentity(candidate.workspace, previousWorkspace)) {
    return value;
  }

  return {
    ...value,
    ...(sameWorkspaceIdentity(value, previousWorkspace)
      ? completedWorkspace
      : {}),
    workspace: completedWorkspace
  };
}

type WorkspaceRecordLike = {
  readonly run_id: string;
  readonly path: string;
  readonly preserved: boolean;
  readonly reason: string;
};

function isWorkspaceRecord(value: unknown): value is WorkspaceRecordLike {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<WorkspaceRecordLike>;
  return (
    typeof candidate.run_id === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.preserved === "boolean" &&
    typeof candidate.reason === "string"
  );
}

function sameWorkspaceIdentity(
  value: unknown,
  workspace: WorkspaceRecordLike
): value is WorkspaceRecordLike {
  return (
    isWorkspaceRecord(value) &&
    value.run_id === workspace.run_id &&
    value.path === workspace.path
  );
}
