import type {
  ResumeWorkflowInput,
  RunWorkflowInput
} from "../../core/workflow/execution-contracts.js";
import { isCheckpointPlainObject } from "../../core/runtime/json.js";
import type { CheckpointRecord } from "../../core/runtime/backends/contracts.js";
import { LUNA_RUNTIME_STATE_SCHEMA_VERSION } from "../../core/runtime/state.js";
import { runtimeError } from "../../core/runtime/errors.js";
import { resumeContextFromMetadata } from "./interrupts.js";
import { checkpointId as waitingCheckpointId } from "./interrupt-wait-protocol.js";
import { validateResumeWaitIntent } from "./resume-wait-intent-validation.js";

export type ValidatedResumeCheckpoint = {
  readonly checkpoint: CheckpointRecord;
  readonly resumeContext: ReturnType<typeof resumeContextFromMetadata>;
  readonly resumeIndex: number;
  readonly resumeNodeId: string;
};

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
  return validated;
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
  TInput extends ResumeWorkflowInput
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
