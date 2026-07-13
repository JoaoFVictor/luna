import type { InterruptStore } from "../../../core/runtime/interrupts/contracts.js";
import { runStoreError } from "../../application/runs/errors.js";
import type { RunLedgerPort } from "../../application/runs/ports.js";
import { RunTerminalStatusSchema } from "../../contracts/runs.js";
import type { NativeStudioRunDispatchQueue } from "../filesystem/run-dispatch-queue.js";
import type { NativeStudioRunResumeIdentity } from "../filesystem/run-resume-identity-contracts.js";
import { NativeStudioRunLease } from "./run-dispatch-lease.js";
import type { NativeStudioRunFinalizer } from "./run-finalizer.js";
import { createNativeStudioRunTerminalIntent } from "./run-terminal-intent.js";

type CorruptResumeRecoveryDependencies = {
  readonly ledger: RunLedgerPort;
  readonly interrupts: Pick<InterruptStore, "get" | "completeResume">;
  readonly queue: NativeStudioRunDispatchQueue;
  readonly finalizer: NativeStudioRunFinalizer;
  readonly now: () => number;
  readonly ownerId: string;
  readonly heartbeatIntervalMs: number;
  readonly orphanThresholdMs: number;
  readonly onBackgroundError: (cause: unknown) => void;
};

async function cancelClaim(
  identity: NativeStudioRunResumeIdentity,
  dependencies: CorruptResumeRecoveryDependencies
): Promise<void> {
  const interrupt = await dependencies.interrupts.get(identity.interrupt_id);
  if (
    interrupt === undefined ||
    interrupt.status === "pending" ||
    interrupt.status === "cancelled"
  ) return;
  if (interrupt.status === "resolved") {
    if (interrupt.resume?.resume_id !== identity.resume_id) {
      throw runStoreError(
        "run_store_corrupt",
        "Corrupt resume identity conflicts with resolved interrupt"
      );
    }
    return;
  }
  if (interrupt.resume_attempt !== identity.resume_id) {
    throw runStoreError(
      "run_store_corrupt",
      "Corrupt resume identity conflicts with interrupt claim"
    );
  }
  await dependencies.interrupts.completeResume(identity.interrupt_id, {
    interrupt_id: identity.interrupt_id,
    resume_attempt: identity.resume_id,
    status: "claimed"
  }, "cancelled");
}

/** Converges an unreadable resume while its integrity sidecar protects the run. */
export async function recoverNativeStudioCorruptResume(
  identity: NativeStudioRunResumeIdentity,
  cause: unknown,
  dependencies: CorruptResumeRecoveryDependencies
): Promise<void> {
  const record = await dependencies.ledger.get(identity.run_id);
  if (record === undefined) {
    await dependencies.queue.removeResume(identity.resume_id);
    return;
  }
  if (
    record.run_status !== undefined &&
    RunTerminalStatusSchema.safeParse(record.run_status).success
  ) {
    await cancelClaim(identity, dependencies);
    await dependencies.queue.removeResume(identity.resume_id);
    return;
  }
  if (record.run_status === "waiting_for_input" || record.run_status === "resuming") {
    if (record.owner_id === undefined) return;
    const lease = new NativeStudioRunLease({
      ledger: dependencies.ledger,
      runId: identity.run_id,
      ownerId: record.owner_id,
      now: dependencies.now,
      heartbeatIntervalMs: dependencies.heartbeatIntervalMs,
      lifecycleExecutionId: identity.resume_id
    });
    await lease.commitTerminal(
      {
        status: "cancelled",
        cause: runStoreError(
          "run_store_corrupt",
          "The accepted interrupt resume command is corrupt"
        )
      },
      { completeness: "partial" },
      async (preparation) => {
        await dependencies.finalizer.commitDurableIntent(
          createNativeStudioRunTerminalIntent({
            runId: preparation.projectedRecord.run_id,
            command: preparation.command
          })
        );
      }
    );
    await cancelClaim(identity, dependencies);
    await dependencies.queue.removeResume(identity.resume_id);
    return;
  }
  if (record.run_status !== "running") return;
  const heartbeatAt = record.heartbeat_at;
  const staleBeforeMs = dependencies.now() - dependencies.orphanThresholdMs;
  if (
    heartbeatAt === undefined ||
    !Number.isSafeInteger(staleBeforeMs) ||
    Date.parse(heartbeatAt) >= staleBeforeMs
  ) return;
  const lease = new NativeStudioRunLease({
    ledger: dependencies.ledger,
    runId: identity.run_id,
    ownerId: dependencies.ownerId,
    now: dependencies.now,
    heartbeatIntervalMs: dependencies.heartbeatIntervalMs,
    lifecycleExecutionId: identity.resume_id
  });
  try {
    await lease.claimRecovery({
      run_id: identity.run_id,
      previous_owner_id: record.owner_id ?? dependencies.ownerId,
      expected_revision: record.record_revision,
      expected_heartbeat_at: heartbeatAt,
      stale_before: new Date(staleBeforeMs).toISOString(),
      recovery_intent_hash: identity.command_hash
    });
  } catch (claimCause) {
    const latest = await dependencies.ledger.get(identity.run_id);
    if (latest?.run_status === "running") return;
    throw claimCause;
  }
  await lease.markOutcomeUnknown({
    code: "studio_runtime_resume_command_corrupt",
    message: "A running resume lost its durable command identity"
  });
  await cancelClaim(identity, dependencies);
  await dependencies.queue.removeResume(identity.resume_id);
  dependencies.onBackgroundError(cause);
}
