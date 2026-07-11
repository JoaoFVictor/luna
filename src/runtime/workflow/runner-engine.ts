import type { AgentRuntimePort } from "../../core/agent-runtime/contracts.js";
import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../core/capabilities/json-schema-types.js";
import type { WorkflowRunResult } from "../../core/workflow/execution-contracts.js";
import {
  runtimeDurabilityRecoveryRequiredFrom,
  RuntimeDurabilityRecoveryRequiredError,
  runtimeError
} from "../../core/runtime/errors.js";
import type { JsonValue } from "../../core/runtime/json.js";
import {
  LUNA_RUNTIME_STATE_SCHEMA_VERSION,
  createInitialRuntimeState,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import {
  selectReadyBatchWithPolicy,
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
  runWorkflowNodeAttempt,
  recoverPersistedWorkflowNodeAttempt,
  skipPersistedCompletedWorkflowNode,
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
import { loadCheckpointForRecovery } from "./checkpoint-io.js";
import {
  saveTerminalCheckpoint,
  terminalCheckpointSnapshot
} from "./terminal-checkpoints.js";
import {
  ensureWorkflowExecutionIdentity
} from "./workflow-execution-identity.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput,
  WorkflowAgentInputMap
} from "../../core/workflow/execution-contracts.js";
import {
  applyWorkflowResume,
  preflightWorkflowResume,
  type WorkflowResumeNodeRecovery
} from "./resume-application.js";
import { appendWorkflowEvent } from "../../core/workflow/events.js";
import { deferredFinalReportNodeIds } from "./deferred-final-report.js";
import {
  mergeNodeFailureWithCheckpoint,
  nodeAttemptFailure,
  observeFailedState,
  runtimeStateFromCheckpoint
} from "./failure-state.js";
import { loadPersistedWorkflowNodeRecovery } from "./persisted-node-recovery.js";

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
  return await input.backends.interrupts.withResumeLease(
    input.run.run_id,
    async () => {
      await assertWorkflowRunIsOpen(input, input.run.run_id);
      await ensureWorkflowExecutionIdentity(input, input.run.run_id);
      let state = createInitialRuntimeState({
        invocation: input.invocation,
        config: input.config,
        run: input.run,
        workflow: { id: input.workflow.id, mode: input.workflow.mode }
      });
      const recovered = await loadPersistedWorkflowNodeRecovery(
        input,
        input.run.run_id
      );
      state = {
        ...state,
        artifact_refs: recovered.completedArtifactRefs,
        interrupt_refs: recovered.completedInterruptRefs,
        steps: Object.fromEntries(
          recovered.stepWrites.map((write) => [write.task_id, write.value])
        )
      };
      return await runWithWorkflowSpan(input, async () =>
        await runFromNodeIndex(input, scheduler, state, 0, {
          completedNodeIds: recovered.completedNodeIds,
          outputPendingByNode: recovered.outputPendingByNode
        })
      );
    }
  );
}

export async function resumeCompiledWorkflowWithScheduler<TInput extends ResumeWorkflowInput>(
  input: TInput,
  scheduler: WorkflowNodeScheduler<RunWorkflowInput & TInput>
): Promise<WorkflowRunResult> {
  assertCompiledWorkflowMatchesDefinition(input);
  assertSupportedExecutionSubset(input);
  return await input.backends.interrupts.withResumeLease(
    input.thread_id,
    async () => {
      await assertWorkflowRunIsOpen(input, input.thread_id);
      const preflight = await preflightWorkflowResume(input);
      await ensureWorkflowExecutionIdentity({
        backends: input.backends,
        compiled: input.compiled,
        invocation: preflight.resumeContext.invocation,
        config: preflight.resumeContext.config,
        run: preflight.resumeContext.run
      }, input.thread_id, { validatedLegacyResume: true });
      const resume = await applyWorkflowResume(input, preflight);
      assertSupportedRuntimeRequirements(input, resume.startIndex);

      return await runWithWorkflowSpan(resume.resumedInput, async () =>
        await runFromNodeIndex(
          resume.resumedInput,
          scheduler,
          resume.state,
          resume.startIndex,
          resume.nodeRecovery
        )
      );
    }
  );
}

async function assertWorkflowRunIsOpen(
  input: Pick<RunWorkflowInput, "backends" | "compiled" | "workflow">,
  threadId: string
): Promise<void> {
  const statuses = ["succeeded", "failed"] as const;
  const terminals = await Promise.all(statuses.map(async (status) => {
    const checkpointId = `terminal-${threadId}-${status}`;
    const record = await loadCheckpointForRecovery({
      input,
      threadId,
      checkpointId,
      checkpointNs: "",
      operation: "load_terminal_preflight"
    });
    return { checkpointId, record, status };
  }));
  const present = terminals.filter(
    (terminal): terminal is typeof terminal & {
      readonly record: NonNullable<typeof terminal.record>;
    } => terminal.record !== undefined
  );

  for (const { checkpointId, record, status } of present) {
    if (
      record.thread_id !== threadId ||
      record.checkpoint_ns !== "" ||
      record.checkpoint_id !== checkpointId ||
      record.state_schema_version !== input.compiled.state_schema_version ||
      record.state.state_schema_version !== input.compiled.state_schema_version ||
      record.state.run_status !== status ||
      record.metadata.source !== "terminal" ||
      record.metadata.run_status !== status ||
      record.metadata.workflow_revision !== input.workflow.revision
    ) {
      throw runtimeError(
        "Terminal checkpoint is not internally consistent",
        "runtime_checkpoint_schema_mismatch",
        { details: { checkpoint_id: checkpointId, thread_id: threadId } }
      );
    }
  }
  if (present.length > 1) {
    throw runtimeError(
      "Workflow run has conflicting terminal checkpoints",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          reason: "conflicting_terminal_checkpoints",
          thread_id: threadId,
          checkpoint_ids: present.map(({ checkpointId }) => checkpointId)
        }
      }
    );
  }
  const terminal = present[0];
  if (terminal === undefined) {
    return;
  }
  throw runtimeError(
    "Workflow run is already terminal and cannot be replayed or resumed",
    "runtime_state_invalid",
    {
      details: {
        checkpoint_id: terminal.checkpointId,
        run_status: terminal.status,
        thread_id: threadId
      }
    }
  );
}

async function runWithWorkflowSpan<TInput extends RunWorkflowInput>(
  input: TInput,
  run: () => Promise<WorkflowRunResult>
): Promise<WorkflowRunResult> {
  if (input.observability === undefined) {
    return await run();
  }

  let committedResult: WorkflowRunResult | undefined;
  let primaryFailure: unknown;
  try {
    return await input.observability.recorder.withSpan(
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
        committedResult = result;
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
  } catch (cause) {
    if (committedResult !== undefined) {
      return committedResult;
    }
    primaryFailure = cause;
    throw cause;
  } finally {
    try {
      await input.observability.close();
      await writeTraceSummaryBestEffort(
        input.artifactPublisher,
        input.observability.snapshotSummary()
      );
    } catch (cause) {
      if (committedResult === undefined && primaryFailure === undefined) {
        throw cause;
      }
      // Preserve a primary runtime failure, or a result committed by the
      // runtime, over failures from diagnostic shutdown/projection.
    }
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
  startIndex: number,
  nodeRecovery?: WorkflowResumeNodeRecovery
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
  let state = initialState;
  let exactStateAvailable = false;
  let terminalizationPhase: SuccessTerminalizationPhase = "open";
  try {
    const result = await scheduler({
      input,
      initialState,
      nodes,
      startIndex,
      deferredFinalReportIds,
      runtimeContext,
      runNode: async (node, currentState) => {
        const decision = executionPolicyDecisionForCompiledNode(input, node);
        if (nodeRecovery?.completedNodeIds.has(node.id) === true) {
          return skipPersistedCompletedWorkflowNode({
            state: currentState,
            node
          });
        }
        const pendingOutput = nodeRecovery?.outputPendingByNode.get(node.id);
        if (pendingOutput !== undefined) {
          return await recoverPersistedWorkflowNodeAttempt({
            input,
            state: currentState,
            runtimeContext,
            node,
            decision,
            output: pendingOutput
          });
        }
        return await runWorkflowNodeAttempt({
          input,
          state: currentState,
          runtimeContext,
          node,
          decision
        });
      }
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
    exactStateAvailable = true;

    const output = assertFinalWorkflowOutput(input, state, deferredFinalReportIds);
    input.signal?.throwIfAborted();

    state = { ...state, run_status: "succeeded" };
    input.signal?.throwIfAborted();
    if (input.onSucceededState === undefined) {
      terminalizationPhase = "runtime_checkpoint_pending";
      await saveTerminalCheckpoint({
        input,
        state: terminalCheckpointSnapshot(state, "succeeded")
      });
      terminalizationPhase = "committed";
    } else {
      terminalizationPhase = "control_plane_pending";
      await input.onSucceededState(state);
      terminalizationPhase = "committed";
      await saveSecondarySuccessCheckpointBestEffort(input, state);
    }
    try {
      await appendWorkflowEvent(input, "run.succeeded");
    } catch {
      // The terminal checkpoint is the success linearization point. A late
      // observability failure cannot rewrite an already committed outcome.
    }
    return { status: "succeeded", output, state };
  } catch (caught) {
    if (terminalizationPhase !== "open") {
      throw caught;
    }
    const attemptFailure = nodeAttemptFailure(caught);
    const checkpointWriteFailure = attemptFailure?.runtimeCause ?? caught;
    const durabilityFailure = runtimeDurabilityRecoveryRequiredFrom(
      checkpointWriteFailure
    );
    if (durabilityFailure !== undefined) {
      // A deterministic write may already be committed. A failed terminal
      // would contradict that possible authority and block exact recovery.
      throw durabilityFailure;
    }
    return await failWorkflowExecution({
      input,
      initialState,
      currentState: state,
      exactStateAvailable,
      caught
    });
  }
}

type SuccessTerminalizationPhase =
  | "open"
  | "runtime_checkpoint_pending"
  | "control_plane_pending"
  | "committed";

async function saveSecondarySuccessCheckpointBestEffort(
  input: RunWorkflowInput,
  state: LunaRuntimeState
): Promise<void> {
  try {
    await saveTerminalCheckpoint({
      input,
      state: terminalCheckpointSnapshot(state, "succeeded")
    });
  } catch {
    // The control-plane intent is already the success authority. Its recovery
    // path must not be contradicted by a secondary checkpoint backend failure.
  }
}

function assertFinalWorkflowOutput(
  input: RunWorkflowInput,
  state: LunaRuntimeState,
  deferredFinalReportIds: ReadonlySet<string>
): JsonValue {
  const output = finalWorkflowOutput(input.compiled, state, deferredFinalReportIds);
  if (
    input.executionScope?.kind !== "through_node" &&
    !matchesJsonSchema(input.workflow.output_schema_content as JsonSchemaLike, output)
  ) {
    throw runtimeError("Final workflow output failed schema validation", "runtime_node_output_schema_invalid", {
      details: { workflow_id: input.workflow.id }
    });
  }
  return output;
}

async function failWorkflowExecution({
  input,
  initialState,
  currentState,
  exactStateAvailable,
  caught
}: {
  readonly input: RunWorkflowInput;
  readonly initialState: LunaRuntimeState;
  readonly currentState: LunaRuntimeState;
  readonly exactStateAvailable: boolean;
  readonly caught: unknown;
}): Promise<never> {
  const attemptFailure = nodeAttemptFailure(caught);
  const runtimeCause = attemptFailure?.runtimeCause ?? caught;
  const observable = attemptFailure !== undefined || exactStateAvailable;
  let failedState: LunaRuntimeState = {
    ...(attemptFailure?.state ?? currentState),
    run_status: "failed"
  };
  try {
    const latestCheckpoint = await input.backends.checkpoints.load(input.run.run_id);
    if (attemptFailure !== undefined) {
      failedState = mergeNodeFailureWithCheckpoint(
        attemptFailure.state,
        latestCheckpoint?.state
      );
    } else if (!exactStateAvailable) {
      failedState =
        runtimeStateFromCheckpoint(latestCheckpoint?.state) ?? initialState;
    }
    failedState = { ...failedState, run_status: "failed" };
    await saveTerminalCheckpoint({
      input,
      state: terminalCheckpointSnapshot(failedState, "failed")
    });
  } catch (terminalizationCause) {
    // Without an exact failed terminal, replay could rerun a node whose
    // external effect happened before its output marker was persisted. Do not
    // publish a contradictory terminal event/projection; force the caller to
    // reconcile the durable execution identity instead.
    throw new RuntimeDurabilityRecoveryRequiredError(
      "Failed workflow outcome could not be durably established",
      {
        cause: terminalizationCause,
        details: {
          run_id: input.run.run_id,
          runtime_failure_kind:
            runtimeCause instanceof Error ? runtimeCause.name : typeof runtimeCause
        }
      }
    );
  }
  try {
    await appendWorkflowEvent(input, "run.failed");
  } catch {
    // Preserve the authoritative runtime failure over diagnostics.
  }
  if (observable) {
    observeFailedState(input, failedState);
  }
  throw runtimeCause;
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
