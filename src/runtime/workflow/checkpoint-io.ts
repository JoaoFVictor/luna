import type {
  CheckpointRecord,
  CheckpointWriteRecord,
  SaveCheckpointInput
} from "../../core/runtime/backends/contracts.js";
import {
  isRuntimeDurabilityRecoveryRequired,
  RuntimeError,
  RuntimeDurabilityRecoveryRequiredError,
  runtimeError
} from "../../core/runtime/errors.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import { canonicalJson } from "../../core/workflow/definition-digests.js";

export class CheckpointWriteAcceptanceUnknownError extends RuntimeDurabilityRecoveryRequiredError {
  readonly saveCause: unknown;
  readonly verificationCause: unknown;

  constructor(
    write: CheckpointWriteRecord,
    saveCause: unknown,
    verificationCause: unknown
  ) {
    super(
      "Checkpoint write may be committed, but exact readback was unavailable",
      {
        cause: saveCause,
        details: {
          thread_id: write.thread_id,
          checkpoint_ns: write.checkpoint_ns,
          checkpoint_id: write.checkpoint_id,
          task_id: write.task_id,
          index: write.index,
          channel: write.channel
        }
      },
      "runtime_checkpoint_write_acceptance_unknown"
    );
    this.name = "CheckpointWriteAcceptanceUnknownError";
    this.saveCause = saveCause;
    this.verificationCause = verificationCause;
  }
}

export function isCheckpointWriteAcceptanceUnknown(
  cause: unknown
): cause is CheckpointWriteAcceptanceUnknownError {
  return cause instanceof CheckpointWriteAcceptanceUnknownError;
}

export async function listCheckpointWritesForRecovery({
  input,
  threadId,
  checkpointNs,
  checkpointId,
  operation
}: {
  readonly input: Pick<RunWorkflowInput, "backends">;
  readonly threadId: string;
  readonly checkpointNs: string;
  readonly checkpointId: string;
  readonly operation: string;
}): Promise<CheckpointWriteRecord[]> {
  try {
    return await input.backends.checkpoints.listWrites(
      threadId,
      checkpointNs,
      checkpointId
    );
  } catch (cause) {
    if (isRuntimeDurabilityRecoveryRequired(cause)) {
      throw cause;
    }
    throw checkpointReadRecoveryRequired(cause, operation, threadId, {
      checkpoint_ns: checkpointNs,
      checkpoint_id: checkpointId
    });
  }
}

export async function hasThreadCheckpointWritesForRecovery({
  input,
  threadId,
  operation
}: {
  readonly input: Pick<RunWorkflowInput, "backends">;
  readonly threadId: string;
  readonly operation: string;
}): Promise<boolean> {
  try {
    return await input.backends.checkpoints.hasThreadWrites(threadId);
  } catch (cause) {
    if (isRuntimeDurabilityRecoveryRequired(cause)) {
      throw cause;
    }
    throw checkpointReadRecoveryRequired(cause, operation, threadId);
  }
}

export async function loadCheckpointForRecovery({
  input,
  threadId,
  checkpointId,
  checkpointNs,
  operation
}: {
  readonly input: Pick<RunWorkflowInput, "backends">;
  readonly threadId: string;
  readonly checkpointId: string;
  readonly checkpointNs: string;
  readonly operation: string;
}): Promise<CheckpointRecord | undefined> {
  try {
    return await input.backends.checkpoints.load(threadId, {
      checkpointId,
      checkpointNs
    });
  } catch (cause) {
    throw checkpointReadRecoveryRequired(cause, operation, threadId, {
      checkpoint_id: checkpointId,
      checkpoint_ns: checkpointNs
    });
  }
}

function checkpointReadRecoveryRequired(
  cause: unknown,
  operation: string,
  threadId: string,
  details: Record<string, unknown> = {}
): RuntimeError {
  if (cause instanceof RuntimeError) {
    return cause;
  }
  return new RuntimeDurabilityRecoveryRequiredError(
    "Checkpoint protocol read requires durable reconciliation",
    {
      cause,
      details: { operation, thread_id: threadId, ...details }
    }
  );
}

export async function saveCheckpointWriteExactly(
  input: Pick<RunWorkflowInput, "backends">,
  write: CheckpointWriteRecord
): Promise<void> {
  try {
    await input.backends.checkpoints.saveWrites([write]);
  } catch (saveCause) {
    let committedWrites: CheckpointWriteRecord[];
    try {
      committedWrites = await input.backends.checkpoints.listWrites(
        write.thread_id,
        write.checkpoint_ns,
        write.checkpoint_id
      );
    } catch (verificationCause) {
      throw new CheckpointWriteAcceptanceUnknownError(
        write,
        saveCause,
        verificationCause
      );
    }
    const exactWrite = committedWrites.find(
      (candidate) =>
        candidate.task_id === write.task_id &&
        candidate.index === write.index &&
        candidate.channel === write.channel &&
        canonicalJson(candidate.value) === canonicalJson(write.value)
    );
    if (exactWrite !== undefined) {
      return;
    }
    throw saveCause;
  }
}

export function checkpointMatchesInput(
  record: CheckpointRecord,
  input: SaveCheckpointInput
): boolean {
  return (
    record.thread_id === input.thread_id &&
    record.checkpoint_id === input.checkpoint_id &&
    record.checkpoint_ns === (input.checkpoint_ns ?? "") &&
    record.state_schema_version === input.state_schema_version &&
    canonicalJson(record.state) === canonicalJson(input.state) &&
    canonicalJson(record.metadata) === canonicalJson(input.metadata ?? {}) &&
    (input.checkpoint === undefined ||
      canonicalJson(record.checkpoint) === canonicalJson(input.checkpoint)) &&
    (input.parent_config === undefined ||
      canonicalJson(record.parent_config) === canonicalJson(input.parent_config)) &&
    (input.created_at === undefined || record.created_at === input.created_at)
  );
}

export async function saveCheckpointExactly(
  input: Pick<RunWorkflowInput, "backends">,
  checkpoint: SaveCheckpointInput
): Promise<void> {
  const existing = await input.backends.checkpoints.load(checkpoint.thread_id, {
    checkpointId: checkpoint.checkpoint_id,
    checkpointNs: checkpoint.checkpoint_ns ?? ""
  });
  if (existing !== undefined) {
    if (checkpointMatchesInput(existing, checkpoint)) {
      return;
    }
    throw runtimeError(
      "Checkpoint identity already belongs to different durable state",
      "runtime_state_invalid",
      {
        details: {
          checkpoint_id: checkpoint.checkpoint_id,
          checkpoint_ns: checkpoint.checkpoint_ns ?? "",
          thread_id: checkpoint.thread_id
        }
      }
    );
  }
  try {
    await input.backends.checkpoints.save(checkpoint);
  } catch (saveCause) {
    let committed: CheckpointRecord | undefined;
    try {
      committed = await input.backends.checkpoints.load(checkpoint.thread_id, {
        checkpointId: checkpoint.checkpoint_id,
        checkpointNs: checkpoint.checkpoint_ns ?? ""
      });
    } catch (verificationCause) {
      throw new RuntimeDurabilityRecoveryRequiredError(
        "Checkpoint may be committed, but exact readback was unavailable",
        {
          cause: saveCause,
          details: {
            checkpoint_id: checkpoint.checkpoint_id,
            checkpoint_ns: checkpoint.checkpoint_ns ?? "",
            thread_id: checkpoint.thread_id,
            verification_cause:
              verificationCause instanceof Error
                ? verificationCause.name
                : typeof verificationCause
          }
        }
      );
    }
    if (committed !== undefined && checkpointMatchesInput(committed, checkpoint)) {
      return;
    }
    throw saveCause;
  }
}
