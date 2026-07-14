import type {
  ResumeWorkflowInput,
  RunWorkflowInput
} from "../../core/workflow/execution-contracts.js";
import { isCheckpointPlainObject } from "../../core/runtime/json.js";
import type { CheckpointRecord } from "../../core/runtime/backends/contracts.js";
import {
  LUNA_RUNTIME_STATE_SCHEMA_VERSION,
  createInitialRuntimeState,
  validateCheckpointState,
  type LunaRuntimeState
} from "../../core/runtime/state.js";
import { runtimeError } from "../../core/runtime/errors.js";
import { resumeContextFromMetadata } from "./interrupts.js";
import { checkpointId as waitingCheckpointId } from "./interrupt-wait-protocol.js";
import {
  validatePersistedWaitIntent,
  validateResumeWaitIntent
} from "./resume-wait-intent-validation.js";
import { listCheckpointWritesForRecovery } from "./checkpoint-io.js";
import {
  checkpointArtifactRefs,
  checkpointInterruptRefs
} from "./resume-recovery-codec.js";
import {
  markNodeWaitingForInput,
  startNodeAttempt
} from "../../core/runtime/lifecycle.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";

export type ValidatedResumeCheckpoint = {
  readonly checkpoint: CheckpointRecord;
  readonly resumeContext: ReturnType<typeof resumeContextFromMetadata>;
  readonly resumeIndex: number;
  readonly resumeNodeId: string;
};

type ResumeCheckpointInput = Pick<
  ResumeWorkflowInput,
  | "compiled"
  | "workflow"
  | "backends"
  | "thread_id"
  | "checkpoint_id"
  | "interrupt_id"
>;

/**
 * Validates the durable origin of a resume without changing checkpoints,
 * interrupts, or events. This must run before a legacy execution receives its
 * first workflow-identity checkpoint: an invalid resume request must never be
 * able to bind an old waiting run to the request's workflow revision.
 */
export async function preflightWorkflowResume<TInput extends ResumeWorkflowInput>(
  input: TInput
): Promise<ValidatedResumeCheckpoint> {
  const validated = await loadValidatedResumeCheckpoint(input);
  const interrupt = await input.backends.interrupts.get(input.interrupt_id);
  if (interrupt === undefined) {
    throw runtimeError("Interrupt not found", "runtime_interrupt_not_found", {
      details: { interrupt_id: input.interrupt_id }
    });
  }
  if (
    interrupt.id !== input.interrupt_id ||
    interrupt.run_id !== input.thread_id ||
    interrupt.thread_id !== input.thread_id ||
    interrupt.checkpoint_id !== input.checkpoint_id ||
    interrupt.node_id !== validated.resumeNodeId
  ) {
    throw runtimeError(
      "Interrupt resume does not match the durable waiting checkpoint",
      "interrupt_stale",
      {
        details: {
          interrupt_id: input.interrupt_id,
          checkpoint_id: input.checkpoint_id,
          thread_id: input.thread_id
        }
      }
    );
  }
  const laterNodeIds = input.compiled.nodes
    .slice(validated.resumeIndex + 1)
    .map((node) => node.id);
  const laterNodeInterrupt = laterNodeIds.length === 0
    ? undefined
    : await input.backends.interrupts.findFirst(input.thread_id, {
        exclude_id: interrupt.id,
        node_ids: laterNodeIds
      });
  const repeatedNodeInterrupt = await input.backends.interrupts.findFirst(
    input.thread_id,
    {
      exclude_id: interrupt.id,
      node_ids: [interrupt.node_id],
      created_after: interrupt.created_at
    }
  );
  const laterInterrupt = laterNodeInterrupt ?? repeatedNodeInterrupt;
  if (laterInterrupt !== undefined) {
    throw runtimeError(
      "Interrupt resume is stale relative to a later gate",
      "interrupt_stale",
      {
        details: {
          interrupt_id: input.interrupt_id,
          later_interrupt_id: laterInterrupt.id
        }
      }
    );
  }
  await validateResumeWaitIntent({
    input,
    checkpoint: validated.checkpoint,
    resumeContext: validated.resumeContext,
    resumeNode: input.compiled.nodes[validated.resumeIndex],
    interrupt
  });
  validateReviewDecisionTargets(input, interrupt.payload?.review?.targets);
  validateReviewApproval(input, interrupt.payload?.review?.approval);
  return validated;
}

function validateReviewApproval(
  input: Pick<ResumeWorkflowInput, "decision" | "interrupt_id">,
  approval: { readonly allowed: boolean; readonly reason: string } | undefined
): void {
  if (
    approval === undefined ||
    approval.allowed ||
    !isCheckpointPlainObject(input.decision) ||
    input.decision.action !== "approve"
  ) {
    return;
  }
  throw runtimeError(
    approval.reason,
    "runtime_node_output_schema_invalid",
    {
      details: {
        interrupt_id: input.interrupt_id,
        approval_blocked: true
      }
    }
  );
}

function validateReviewDecisionTargets(
  input: Pick<ResumeWorkflowInput, "decision" | "interrupt_id">,
  availableTargets: readonly { readonly id: string }[] | undefined
): void {
  if (
    !isCheckpointPlainObject(input.decision) ||
    input.decision.action !== "request_changes" ||
    availableTargets === undefined
  ) {
    return;
  }
  const requestedTargets = input.decision.targets;
  if (!Array.isArray(requestedTargets)) {
    return;
  }
  const allowed = new Set((availableTargets ?? []).map(({ id }) => id));
  if (
    requestedTargets.length === 0 ||
    new Set(requestedTargets).size !== requestedTargets.length ||
    requestedTargets.some(
      (target) => typeof target !== "string" || !allowed.has(target)
    )
  ) {
    throw runtimeError(
      "Interrupt decision references an unavailable review target",
      "runtime_node_output_schema_invalid",
      { details: { interrupt_id: input.interrupt_id } }
    );
  }
}

export async function loadValidatedResumeCheckpoint<
  TInput extends ResumeCheckpointInput
>(input: TInput): Promise<ValidatedResumeCheckpoint> {
  const checkpoint = await input.backends.checkpoints.load(input.thread_id, {
    checkpointId: input.checkpoint_id,
    expectedStateSchemaVersion: LUNA_RUNTIME_STATE_SCHEMA_VERSION
  });
  if (checkpoint === undefined) {
    throw runtimeError("Checkpoint not found", "runtime_interrupt_not_found", {
      details: { checkpoint_id: input.checkpoint_id, thread_id: input.thread_id }
    });
  }
  if (
    checkpoint.thread_id !== input.thread_id ||
    checkpoint.checkpoint_id !== input.checkpoint_id ||
    checkpoint.checkpoint_ns !== "" ||
    checkpoint.state.run_status !== "waiting_for_input"
  ) {
    throw runtimeError(
      "Resume checkpoint is not the exact waiting checkpoint requested",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          checkpoint_id: input.checkpoint_id,
          thread_id: input.thread_id
        }
      }
    );
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

  const resumeContext = resumeContextFromMetadata(checkpoint.metadata);
  if (
    resumeContext.run.run_id !== input.thread_id ||
    resumeContext.run.workflow_id !== input.workflow.id ||
    (input.compiled.nodes[resumeIndex]?.kind !== "loop" &&
      input.checkpoint_id !== waitingCheckpointId(input.thread_id, resumeNodeId))
  ) {
    throw runtimeError(
      "Checkpoint resume context conflicts with its execution identity",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          checkpoint_id: input.checkpoint_id,
          thread_id: input.thread_id,
          workflow_id: input.workflow.id
        }
      }
    );
  }

  return {
    checkpoint,
    resumeContext,
    resumeIndex,
    resumeNodeId
  };
}

export async function recoverPersistedWaitingBoundary(
  input: ResumeCheckpointInput
): Promise<WaitingBoundaryResult> {
  return await recoverPersistedWaitingBoundaryByIdentity({
    backends: input.backends,
    thread_id: input.thread_id,
    checkpoint_id: input.checkpoint_id,
    interrupt_id: input.interrupt_id,
    workflow: {
      id: input.workflow.id,
      revision: input.workflow.revision,
      mode: input.workflow.mode,
      state_schema_version: input.compiled.state_schema_version,
      nodes: input.compiled.nodes.map(waitingBoundaryNodeIdentity)
    }
  });
}

export type WaitingBoundaryWorkflowIdentity = {
  readonly id: string;
  readonly revision: string;
  readonly mode: WorkflowDefinition["mode"];
  readonly state_schema_version: string;
  readonly nodes: readonly {
    readonly id: string;
    readonly kind: string;
    readonly wait_capability_id: string;
  }[];
};

type WaitingBoundaryNodeSource = {
  readonly id: string;
  readonly kind: string;
  readonly capability_id: string;
  readonly loop_body?: readonly {
    readonly kind: string;
    readonly capability_id: string;
  }[];
};

export function waitingBoundaryNodeIdentity(
  node: WaitingBoundaryNodeSource
): WaitingBoundaryWorkflowIdentity["nodes"][number] {
  const waitCapabilityId = node.kind === "loop"
    ? node.loop_body?.at(-1)?.kind === "interrupt"
      ? node.loop_body.at(-1)?.capability_id
      : undefined
    : node.capability_id;
  if (waitCapabilityId === undefined || waitCapabilityId === "") {
    throw runtimeError(
      "Pinned workflow node cannot identify its waiting capability",
      "runtime_checkpoint_schema_mismatch",
      { details: { node_id: node.id, node_kind: node.kind } }
    );
  }
  return {
    id: node.id,
    kind: node.kind,
    wait_capability_id: waitCapabilityId
  };
}

export type WaitingBoundaryResult = {
  readonly status: "waiting_for_input";
  readonly interrupt_id: string;
  readonly checkpoint_id: string;
  readonly state: LunaRuntimeState;
};

/**
 * Reconciles an exact durable wait from pinned graph identity alone. This path
 * deliberately does not compile a workflow or resolve its capability catalog.
 */
export async function recoverPersistedWaitingBoundaryByIdentity(
  input: Pick<
    ResumeCheckpointInput,
    "backends" | "thread_id" | "checkpoint_id" | "interrupt_id"
  > & { readonly workflow: WaitingBoundaryWorkflowIdentity }
): Promise<{
  readonly status: "waiting_for_input";
  readonly interrupt_id: string;
  readonly checkpoint_id: string;
  readonly state: LunaRuntimeState;
}> {
  const checkpoint = await input.backends.checkpoints.load(input.thread_id, {
    checkpointId: input.checkpoint_id,
    expectedStateSchemaVersion: LUNA_RUNTIME_STATE_SCHEMA_VERSION
  });
  if (
    checkpoint === undefined ||
    checkpoint.thread_id !== input.thread_id ||
    checkpoint.checkpoint_id !== input.checkpoint_id ||
    checkpoint.checkpoint_ns !== "" ||
    checkpoint.state.run_status !== "waiting_for_input"
  ) {
    throw runtimeError(
      "Waiting recovery requires the exact durable checkpoint",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          checkpoint_id: input.checkpoint_id,
          thread_id: input.thread_id
        }
      }
    );
  }
  if (
    checkpoint.metadata.workflow_revision !== input.workflow.revision ||
    checkpoint.state_schema_version !== input.workflow.state_schema_version
  ) {
    throw runtimeError(
      "Waiting recovery checkpoint identity is incompatible",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          checkpoint_id: input.checkpoint_id,
          workflow_id: input.workflow.id
        }
      }
    );
  }
  const resumeNodeId = String(checkpoint.metadata.resume_node_id ?? "");
  const resumeNode = input.workflow.nodes.find(({ id }) => id === resumeNodeId);
  const resumeContext = resumeContextFromMetadata(checkpoint.metadata);
  if (
    resumeNode === undefined ||
    (resumeNode.kind !== "interrupt" && resumeNode.kind !== "loop") ||
    resumeContext.run.run_id !== input.thread_id ||
    resumeContext.run.workflow_id !== input.workflow.id ||
    (resumeNode.kind !== "loop" &&
      input.checkpoint_id !== waitingCheckpointId(input.thread_id, resumeNodeId))
  ) {
    throw runtimeError(
      "Waiting recovery checkpoint conflicts with pinned graph identity",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          checkpoint_id: input.checkpoint_id,
          workflow_id: input.workflow.id,
          resume_node_id: resumeNodeId
        }
      }
    );
  }
  const interrupt = await input.backends.interrupts.get(input.interrupt_id);
  if (
    interrupt === undefined ||
    interrupt.status !== "pending" ||
    interrupt.run_id !== input.thread_id ||
    interrupt.thread_id !== input.thread_id ||
    interrupt.checkpoint_id !== input.checkpoint_id ||
    interrupt.node_id !== resumeNodeId
  ) {
    throw runtimeError(
      "Durable waiting boundary does not match its pending interrupt",
      "interrupt_stale",
      { details: { interrupt_id: input.interrupt_id } }
    );
  }
  const later = await input.backends.interrupts.findFirst(input.thread_id, {
    exclude_id: interrupt.id,
    statuses: ["pending"]
  });
  if (later !== undefined) {
    throw runtimeError(
      "Durable waiting boundary is stale relative to a later interrupt",
      "interrupt_stale",
      {
        details: {
          interrupt_id: interrupt.id,
          later_interrupt_id: later.id
        }
      }
    );
  }
  const occurrence = resumeNode.kind === "loop"
    ? waitingLoopOccurrence(input, resumeContext, resumeNodeId)
    : undefined;
  await validatePersistedWaitIntent({
    input,
    workflowRevision: input.workflow.revision,
    resumeNodeId,
    expectedCapabilityId: resumeNode.wait_capability_id,
    occurrence,
    checkpoint,
    resumeContext,
    interrupt
  });
  const writes = await listCheckpointWritesForRecovery({
    input,
    threadId: input.thread_id,
    checkpointNs: checkpoint.checkpoint_ns,
    checkpointId: input.checkpoint_id,
    operation: "rehydrate_waiting_boundary"
  });
  let state = createInitialRuntimeState({
    invocation: resumeContext.invocation,
    config: resumeContext.config,
    run: resumeContext.run,
    workflow: { id: input.workflow.id, mode: input.workflow.mode }
  });
  state = {
    ...state,
    steps: Object.fromEntries(
      writes
        .filter(({ channel }) => channel === "steps")
        .map(({ task_id: taskId, value }) => [taskId, value])
    ),
    artifact_refs: checkpointArtifactRefs(checkpoint.state.artifact_refs),
    interrupt_refs: checkpointInterruptRefs(checkpoint.state.interrupt_refs)
  };
  state = markNodeWaitingForInput(
    startNodeAttempt(state, resumeNodeId, 1),
    resumeNodeId
  );
  validateCheckpointState(state);
  return {
    status: "waiting_for_input",
    interrupt_id: interrupt.id,
    checkpoint_id: input.checkpoint_id,
    state
  };
}

function waitingLoopOccurrence(
  input: Pick<ResumeWorkflowInput, "thread_id" | "checkpoint_id" | "interrupt_id">,
  context: ReturnType<typeof resumeContextFromMetadata>,
  resumeNodeId: string
): string {
  const continuation = context.loop_continuation;
  if (
    continuation === undefined ||
    continuation.node_id !== resumeNodeId ||
    !Number.isSafeInteger(continuation.iteration) ||
    continuation.iteration < 1
  ) {
    throw runtimeError(
      "Pinned loop wait is missing its exact continuation occurrence",
      "runtime_checkpoint_schema_mismatch",
      {
        details: {
          thread_id: input.thread_id,
          checkpoint_id: input.checkpoint_id,
          interrupt_id: input.interrupt_id,
          resume_node_id: resumeNodeId
        }
      }
    );
  }
  return `iteration-${continuation.iteration}`;
}

export function resumedInputFromContext<TInput extends ResumeWorkflowInput>(
  input: TInput,
  resumeContext: ReturnType<typeof resumeContextFromMetadata>
): TInput & RunWorkflowInput {
  return {
    ...input,
    run: resumeContext.run,
    invocation: resumeContext.invocation,
    config: resumeContext.config,
    ...(resumeContext.precompleted_steps === undefined
      ? {}
      : { precompleted_steps: resumeContext.precompleted_steps }),
    ...(resumeContext.loop_continuation === undefined
      ? {}
      : { loop_continuation: resumeContext.loop_continuation })
  };
}
