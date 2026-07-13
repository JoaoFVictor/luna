import type { RunLedgerPort } from "../../application/runs/ports.js";
import { StudioRunResumeError } from "../../application/runs/resume-errors.js";
import type { RunRecord } from "../../contracts/runs.js";
import {
  isNativeStudioRunDispatchQueueCorruption,
  type NativeStudioRunDispatchQueue
} from "../filesystem/run-dispatch-queue.js";
import type { NativeStudioQueuedResume } from "../filesystem/run-resume-contracts.js";
import type { NativeStudioRunLease } from "./run-dispatch-lease.js";
import { nativeStudioActiveResumeReplayIsSafe } from "./run-recovery-safety.js";

type RunningResumeRecoveryDependencies = {
  readonly queue: NativeStudioRunDispatchQueue;
  readonly ledger: RunLedgerPort;
  readonly now: () => number;
  readonly orphanThresholdMs: number;
  readonly onBackgroundError: (cause: unknown) => void;
  readonly createRecoveryLease: (
    job: NativeStudioQueuedResume
  ) => NativeStudioRunLease;
  readonly assertCompatible: (
    job: NativeStudioQueuedResume,
    record: RunRecord,
    sourceJob: Awaited<ReturnType<NativeStudioRunDispatchQueue["read"]>>
  ) => void;
  readonly cancelClaimed: (
    job: NativeStudioQueuedResume,
    lease: NativeStudioRunLease,
    cause: unknown
  ) => Promise<void>;
  readonly markUnknown: (
    job: NativeStudioQueuedResume,
    lease: NativeStudioRunLease,
    code: string,
    message: string
  ) => Promise<void>;
  readonly schedule: (resumeId: string) => void;
};

type RunningResumeOwnership =
  | { readonly kind: "active" }
  | {
      readonly kind: "stale";
      readonly heartbeatAt: string;
      readonly staleBeforeMs: number;
    };

function classifyRunningResumeOwnership(
  record: RunRecord,
  now: number,
  orphanThresholdMs: number
): RunningResumeOwnership {
  const heartbeatAt = record.heartbeat_at;
  const staleBeforeMs = now - orphanThresholdMs;
  if (
    heartbeatAt === undefined ||
    !Number.isSafeInteger(staleBeforeMs) ||
    Date.parse(heartbeatAt) >= staleBeforeMs
  ) {
    return { kind: "active" };
  }
  return { kind: "stale", heartbeatAt, staleBeforeMs };
}

/**
 * Reconciles only a durable resume whose ledger is already running.
 *
 * The immutable resume command supplies identity, the stage journal supplies
 * replay classification, and the ledger CAS supplies ownership. Keeping the
 * three authorities together prevents callers from accidentally scheduling a
 * replay after checking only one of them.
 */
export async function recoverNativeStudioRunningResume(
  job: NativeStudioQueuedResume,
  record: RunRecord,
  dependencies: RunningResumeRecoveryDependencies
): Promise<string | undefined> {
  const ownership = classifyRunningResumeOwnership(
    record,
    dependencies.now(),
    dependencies.orphanThresholdMs
  );
  if (ownership.kind === "active") {
    return job.run_id;
  }

  const sourceJob = await dependencies.queue.read(job.run_id);
  let resumeStage: Awaited<
    ReturnType<NativeStudioRunDispatchQueue["readResumeStage"]>
  > = undefined;
  try {
    resumeStage = await dependencies.queue.readResumeStage(job);
  } catch (cause) {
    if (!isNativeStudioRunDispatchQueueCorruption(cause)) throw cause;
    // Integrity loss can never authorize replay. Preserve the immutable
    // command as identity and converge the run to action-required below.
    dependencies.onBackgroundError(cause);
  }
  const replaySafe = resumeStage?.stage === "pre_execution" &&
    nativeStudioActiveResumeReplayIsSafe({
      sideEffects: record.side_effects,
      activeNodeIds: record.active_node_ids,
      lifecycleProjection: record.lifecycle_projection
    });
  const recoveryLease = dependencies.createRecoveryLease(job);
  try {
    await recoveryLease.claimRecovery({
      run_id: job.run_id,
      previous_owner_id: record.owner_id ?? job.owner_id,
      expected_revision: record.record_revision,
      expected_heartbeat_at: ownership.heartbeatAt,
      stale_before: new Date(ownership.staleBeforeMs).toISOString(),
      recovery_intent_hash: job.command_hash
    });
  } catch (cause) {
    const latest = await dependencies.ledger.get(job.run_id);
    if (latest?.run_status === "running") return job.run_id;
    throw cause;
  }

  try {
    dependencies.assertCompatible(job, record, sourceJob);
  } catch (cause) {
    if (!(cause instanceof StudioRunResumeError)) throw cause;
    if (replaySafe) {
      await dependencies.cancelClaimed(job, recoveryLease, cause);
    } else {
      await dependencies.markUnknown(
        job,
        recoveryLease,
        "studio_run_resume_catalog_changed",
        "Runtime capability catalog changed after a resume effect may have started"
      );
    }
    return undefined;
  }

  if (!replaySafe) {
    await dependencies.markUnknown(
      job,
      recoveryLease,
      "studio_runtime_resume_write_outcome_unknown",
      "A resumed effect may have completed before runtime recovery"
    );
    return undefined;
  }
  dependencies.schedule(job.resume_id);
  return job.run_id;
}
