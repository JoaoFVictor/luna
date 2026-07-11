import type { RunLedgerPort } from "../../application/runs/ports.js";
import type { RunRecord } from "../../contracts/runs.js";
import type { NativeStudioQueuedRun } from "../filesystem/run-dispatch-contracts.js";
import {
  isNativeStudioRunRecoveryJournalCorruption,
  type NativeStudioRunRecoveryJournalPort
} from "../filesystem/run-recovery-journal.js";
import { studioRunLaunchError } from "../../application/runs/launch-errors.js";
import {
  nativeStudioTransitionTimestamp,
  type NativeStudioRunRecoveryClaim
} from "./run-dispatch-lease.js";
import { NativeStudioRunFinalizer } from "./run-finalizer.js";

const ORPHAN_BATCH_SIZE = 200;
const MAX_ORPHAN_CANDIDATES_PER_SWEEP = 10_000;

export type NativeStudioRunRecoveryJobInspection =
  | "present"
  | "missing"
  | "corrupt";

function isUnfinishedStartedRun(record: RunRecord): boolean {
  return record.dispatch_status === "started" &&
    record.run_status !== "succeeded" &&
    record.run_status !== "failed" &&
    record.run_status !== "outcome_unknown" &&
    record.run_status !== "timed_out" &&
    record.run_status !== "cancelled" &&
    record.run_status !== "waiting_for_input";
}

export class NativeStudioRunRecovery {
  readonly #ledger: RunLedgerPort;
  readonly #now: () => number;
  readonly #orphanThresholdMs: number;
  readonly #finalizer: NativeStudioRunFinalizer;
  readonly #recoveryJournal: NativeStudioRunRecoveryJournalPort;
  readonly #scheduleQueuedRun: (runId: string) => void;
  readonly #scheduleRecoveryRun: (
    claim: NativeStudioRunRecoveryClaim
  ) => void;
  readonly #onBackgroundError: (cause: unknown) => void;

  constructor(options: {
    readonly ledger: RunLedgerPort;
    readonly now: () => number;
    readonly orphanThresholdMs: number;
    readonly finalizer: NativeStudioRunFinalizer;
    readonly recoveryJournal: NativeStudioRunRecoveryJournalPort;
    readonly scheduleQueuedRun: (runId: string) => void;
    readonly scheduleRecoveryRun: (
      claim: NativeStudioRunRecoveryClaim
    ) => void;
    readonly onBackgroundError: (cause: unknown) => void;
  }) {
    this.#ledger = options.ledger;
    this.#now = options.now;
    this.#orphanThresholdMs = options.orphanThresholdMs;
    this.#finalizer = options.finalizer;
    this.#recoveryJournal = options.recoveryJournal;
    this.#scheduleQueuedRun = options.scheduleQueuedRun;
    this.#scheduleRecoveryRun = options.scheduleRecoveryRun;
    this.#onBackgroundError = options.onBackgroundError;
  }

  async recoverJob(job: NativeStudioQueuedRun): Promise<void> {
    let record = await this.#ledger.get(job.run_id);
    if (record === undefined) {
      record = (await this.#ledger.preallocate(job.preallocation)).record;
    }
    if (record.execution_snapshot_hash !== job.execution_snapshot_hash) {
      await this.failCorruptJob(
        job.run_id,
        new Error("ledger execution snapshot does not match durable job")
      );
      return;
    }
    if (record.dispatch_status === "queued") {
      this.#scheduleQueuedRun(job.run_id);
      return;
    }
    // A preparing/started owner may belong to another healthy Studio process.
    // Startup reconciliation considers it only through the stale-heartbeat CAS
    // path below.
  }

  async failCorruptJob(
    runId: string,
    cause: unknown,
    queuedFailureCode = "studio_dispatch_snapshot_invalid"
  ): Promise<void> {
    const record = await this.#ledger.get(runId).catch(() => undefined);
    if (record === undefined || record.dispatch_status === "rejected") {
      this.#onBackgroundError(cause);
      return;
    }
    if (record.dispatch_status === "queued") {
      await this.rejectOrphan(record, queuedFailureCode);
      return;
    }
    this.#onBackgroundError(cause);
  }

  async recoverStaleJobs(input: {
    readonly jobIds: ReadonlySet<string>;
    readonly corruptJobIds: ReadonlySet<string>;
    readonly terminalCorruptRunIds: ReadonlySet<string>;
    readonly activeRunIds?: ReadonlySet<string>;
    readonly inspectJob?: (
      runId: string
    ) => Promise<NativeStudioRunRecoveryJobInspection>;
  }): Promise<void> {
    const now = this.#now();
    const staleBeforeMs = now - this.#orphanThresholdMs;
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(staleBeforeMs)
    ) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Native run recovery clock is invalid"
      );
    }
    const staleBefore = new Date(staleBeforeMs).toISOString();
    const activeRunIds = input.activeRunIds ?? new Set<string>();
    let cursor: { readonly stale_since: string; readonly run_id: string } |
      undefined;
    let examined = 0;
    while (examined < MAX_ORPHAN_CANDIDATES_PER_SWEEP) {
      const limit = Math.min(
        ORPHAN_BATCH_SIZE,
        MAX_ORPHAN_CANDIDATES_PER_SWEEP - examined
      );
      const candidates = await this.#ledger.listOrphanCandidates({
        stale_before: staleBefore,
        limit,
        ...(cursor === undefined ? {} : { cursor })
      });
      if (candidates.length === 0) {
        break;
      }
      for (const candidate of candidates) {
        const runId = candidate.record.run_id;
        if (activeRunIds.has(runId)) {
          continue;
        }
        try {
          let hasJob = input.jobIds.has(runId);
          let snapshotCorrupt = input.corruptJobIds.has(runId);
          const terminalCorrupt = input.terminalCorruptRunIds.has(runId);
          // The startup scan is only a hint. Re-open every stale candidate so
          // a job removed, replaced, or corrupted after that scan cannot be
          // authorized for recovery from stale in-memory metadata.
          if (input.inspectJob !== undefined) {
            const inspection = await input.inspectJob(runId);
            hasJob = inspection !== "missing";
            snapshotCorrupt ||= inspection === "corrupt";
          }
          if (
            hasJob &&
            !snapshotCorrupt &&
            !terminalCorrupt &&
            await this.#finalizer.recover(runId)
          ) {
            continue;
          }
          await this.reconcileStaleCandidate(
            candidate.record,
            staleBeforeMs,
            snapshotCorrupt,
            terminalCorrupt,
            !hasJob
          );
        } catch (cause) {
          if (!isRevisionConflict(cause)) {
            this.#onBackgroundError(cause);
          }
        }
      }
      examined += candidates.length;
      const last = candidates.at(-1);
      if (last === undefined || candidates.length < limit) {
        break;
      }
      cursor = {
        stale_since: last.stale_since,
        run_id: last.record.run_id
      };
    }
  }

  private async rejectOrphan(record: RunRecord, code: string): Promise<void> {
    const reconciliationId = `reconcile-${record.record_revision}-${code}`;
    await this.#ledger.appendTransition({
      run_id: record.run_id,
      transition_id: reconciliationId,
      event_id: `event-${reconciliationId}`,
      expected_revision: record.record_revision,
      occurred_at: nativeStudioTransitionTimestamp(this.#now, record),
      transition: {
        kind: "dispatch_rejected",
        ...(record.owner_id === undefined ? {} : { owner_id: record.owner_id }),
        failure: {
          code,
          message: "Native run could not be replayed safely after process recovery"
        }
      }
    });
  }

  private async failStartedOrphan(
    record: RunRecord,
    code: string
  ): Promise<void> {
    if (record.owner_id === undefined) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Started native run has no recovery owner"
      );
    }
    const reconciliationId = `reconcile-${record.record_revision}-${code}`;
    await this.#ledger.appendTransition({
      run_id: record.run_id,
      transition_id: reconciliationId,
      event_id: `event-${reconciliationId}`,
      expected_revision: record.record_revision,
      occurred_at: nativeStudioTransitionTimestamp(this.#now, record),
      transition: {
        kind: "runtime_status",
        owner_id: record.owner_id,
        status: "outcome_unknown",
        active_node_ids: [],
        completeness: "partial",
        failure: {
          code,
          message: "Native run outcome is unknown and requires manual review"
        }
      }
    });
  }

  private async reconcileStaleCandidate(
    candidate: RunRecord,
    staleBeforeMs: number,
    snapshotCorrupt: boolean,
    terminalCorrupt: boolean,
    missingJob: boolean
  ): Promise<void> {
    const current = await this.#ledger.get(candidate.run_id);
    if (
      current === undefined ||
      current.record_revision !== candidate.record_revision ||
      current.owner_id !== candidate.owner_id ||
      current.heartbeat_at !== candidate.heartbeat_at ||
      current.heartbeat_at === undefined ||
      Date.parse(current.heartbeat_at) >= staleBeforeMs
    ) {
      return;
    }
    if (current.dispatch_status === "preparing") {
      await this.rejectOrphan(
        current,
        terminalCorrupt
          ? "studio_dispatch_terminal_recovery_invalid"
          : snapshotCorrupt
          ? "studio_dispatch_snapshot_invalid"
          : missingJob
            ? "studio_dispatch_job_missing"
          : "studio_dispatch_orphaned"
      );
      return;
    }
    if (isUnfinishedStartedRun(current)) {
      if (!terminalCorrupt && !snapshotCorrupt && !missingJob) {
        if (current.owner_id === undefined) {
          throw studioRunLaunchError(
            "studio_run_dispatch_failed",
            "Started native run has no recovery owner"
          );
        }
        let intent;
        try {
          intent = await this.#recoveryJournal.read(current.run_id);
        } catch (cause) {
          if (isNativeStudioRunRecoveryJournalCorruption(cause)) {
            await this.failStartedOrphan(
              current,
              "studio_runtime_recovery_intent_invalid"
            );
            return;
          }
          throw cause;
        }
        if (intent === undefined) {
          await this.failStartedOrphan(
            current,
            "studio_runtime_replay_not_authorized"
          );
          return;
        }
        if (
          intent.run_id !== current.run_id ||
          intent.execution_snapshot_hash !== current.execution_snapshot_hash
        ) {
          await this.failStartedOrphan(
            current,
            "studio_runtime_recovery_intent_invalid"
          );
          return;
        }
        // Only an exact, durable recovery intent may authorize replay. The
        // dispatcher re-reads it before the stale-owner revision CAS.
        this.#scheduleRecoveryRun({
          run_id: current.run_id,
          previous_owner_id: current.owner_id,
          expected_revision: current.record_revision,
          expected_heartbeat_at: current.heartbeat_at,
          stale_before: new Date(staleBeforeMs).toISOString(),
          recovery_intent_hash: intent.intent_hash
        });
        return;
      }
      await this.failStartedOrphan(current, terminalCorrupt
        ? "studio_runtime_terminal_recovery_invalid"
        : snapshotCorrupt
        ? "studio_dispatch_snapshot_invalid"
        : "studio_runtime_job_missing");
    }
  }
}

function isRevisionConflict(cause: unknown): boolean {
  return (cause as { readonly code?: unknown })?.code ===
    "run_revision_conflict";
}
