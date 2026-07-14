import type { RunLedgerPort } from "../../application/runs/ports.js";
import type { RunRecord } from "../../contracts/runs.js";
import type { InterruptRecord } from "../../../core/runtime/interrupts/contracts.js";
import {
  isNativeStudioRunDispatchQueueCorruption,
  type NativeStudioRunDispatchQueue
} from "../filesystem/run-dispatch-queue.js";
import type { NativeStudioRunRecoveryJournalPort } from "../filesystem/run-recovery-journal.js";
import type { NativeStudioRunRecoveryClaim } from "./run-dispatch-lease.js";
import {
  NativeStudioRunRecovery,
  type NativeStudioRunRecoveryJobInspection
} from "./run-dispatch-recovery.js";
import {
  isNativeStudioRunFinalizationIntegrityFailure,
  type NativeStudioRunFinalizer
} from "./run-finalizer.js";
import {
  isNativeStudioTerminalRecord,
  type NativeStudioRunBackgroundDiagnostic,
  type NativeStudioRunTerminalJobCleanup
} from "./run-terminal-job-cleanup.js";

/** Periodic owner of queue scanning and orphan reconciliation. */
export class NativeStudioRunRecoverySupervisor {
  readonly #queue: NativeStudioRunDispatchQueue;
  readonly #ledger: RunLedgerPort;
  readonly #finalizer: NativeStudioRunFinalizer;
  readonly #recovery: NativeStudioRunRecovery;
  readonly #cleanup: NativeStudioRunTerminalJobCleanup;
  readonly #recoveryIntervalMs: number;
  readonly #activeRunIds: () => ReadonlySet<string>;
  readonly #recoverQueuedResumes: (() => Promise<ReadonlySet<string>>) | undefined;
  readonly #reportDiagnostic: NativeStudioRunBackgroundDiagnostic;
  #tail: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(options: {
    readonly queue: NativeStudioRunDispatchQueue;
    readonly ledger: RunLedgerPort;
    readonly finalizer: NativeStudioRunFinalizer;
    readonly recoveryJournal: NativeStudioRunRecoveryJournalPort;
    readonly now: () => number;
    readonly orphanThresholdMs: number;
    readonly recoveryIntervalMs: number;
    readonly activeRunIds: () => ReadonlySet<string>;
    readonly recoverQueuedResumes?: () => Promise<ReadonlySet<string>>;
    readonly scheduleQueuedRun: (runId: string) => void;
    readonly scheduleRecoveryRun: (
      claim: NativeStudioRunRecoveryClaim
    ) => void;
    readonly cleanup: NativeStudioRunTerminalJobCleanup;
    readonly reportDiagnostic: NativeStudioRunBackgroundDiagnostic;
    readonly findDurableWaitingBoundary?: (
      runId: string
    ) => Promise<InterruptRecord | undefined>;
  }) {
    this.#queue = options.queue;
    this.#ledger = options.ledger;
    this.#finalizer = options.finalizer;
    this.#cleanup = options.cleanup;
    this.#recoveryIntervalMs = options.recoveryIntervalMs;
    this.#activeRunIds = options.activeRunIds;
    this.#recoverQueuedResumes = options.recoverQueuedResumes;
    this.#reportDiagnostic = options.reportDiagnostic;
    this.#recovery = new NativeStudioRunRecovery({
      ledger: options.ledger,
      now: options.now,
      orphanThresholdMs: options.orphanThresholdMs,
      finalizer: options.finalizer,
      recoveryJournal: options.recoveryJournal,
      scheduleQueuedRun: options.scheduleQueuedRun,
      scheduleRecoveryRun: options.scheduleRecoveryRun,
      ...(options.findDurableWaitingBoundary === undefined
        ? {}
        : { findDurableWaitingBoundary: options.findDurableWaitingBoundary }),
      onBackgroundError: (cause) => {
        options.reportDiagnostic("dispatch_recovery_failed", undefined, cause);
      }
    });
  }

  async start(): Promise<void> {
    if (this.#closed) return;
    await this.recoverAvailableJobs();
    this.arm();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#tail;
  }

  private arm(): void {
    if (this.#closed || this.#timer !== undefined) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#tail = this.recoverAvailableJobs()
        .catch((cause) => {
          this.#reportDiagnostic("dispatch_recovery_failed", undefined, cause);
        })
        .finally(() => this.arm());
    }, this.#recoveryIntervalMs);
    this.#timer.unref();
  }

  private async recoverAvailableJobs(): Promise<void> {
    const protectedResumeRunIds = await this.#recoverQueuedResumes?.() ?? new Set<string>();
    await this.#queue.removeAbandonedTerminalJobs().catch((cause) => {
      this.#reportDiagnostic(
        "dispatch_terminal_cleanup_failed",
        undefined,
        cause
      );
    });
    const queueScan = await this.#queue.scanRunIds();
    const runIds = queueScan.runIds;
    if (queueScan.ignoredEntryCount > 0) {
      this.#reportDiagnostic(
        "dispatch_recovery_failed",
        undefined,
        new Error("Native run queue contains isolated invalid sibling entries")
      );
    }
    const corruptRunIds = new Set<string>();
    const terminalCorruptRunIds = new Set<string>();
    for (const runId of runIds) {
      let record: RunRecord | undefined;
      try {
        record = await this.#ledger.get(runId);
      } catch (cause) {
        this.#reportDiagnostic("dispatch_recovery_failed", runId, cause);
        continue;
      }
      try {
        if (await this.#finalizer.recover(runId)) {
          await this.#cleanup.removeIfSafe(runId);
          continue;
        }
      } catch (cause) {
        if (isNativeStudioRunFinalizationIntegrityFailure(cause)) {
          terminalCorruptRunIds.add(runId);
          try {
            await this.#recovery.failCorruptJob(
              runId,
              cause,
              "studio_dispatch_terminal_recovery_invalid"
            );
            await this.#cleanup.removeIfSafe(runId);
          } catch (rejectionCause) {
            this.#reportDiagnostic(
              "dispatch_recovery_failed",
              runId,
              rejectionCause
            );
          }
          continue;
        }
        this.#reportDiagnostic("dispatch_recovery_failed", runId, cause);
        continue;
      }
      if (record !== undefined && isNativeStudioTerminalRecord(record)) {
        await this.#cleanup.removeIfSafe(runId);
        continue;
      }
      if (record !== undefined && record.dispatch_status !== "queued") {
        continue;
      }
      let job;
      try {
        job = await this.#queue.read(runId);
      } catch (cause) {
        if (isNativeStudioRunDispatchQueueCorruption(cause)) {
          corruptRunIds.add(runId);
          try {
            await this.#recovery.failCorruptJob(runId, cause);
          } catch (rejectionCause) {
            this.#reportDiagnostic(
              "dispatch_recovery_failed",
              runId,
              rejectionCause
            );
          }
        } else {
          this.#reportDiagnostic("dispatch_recovery_failed", runId, cause);
        }
        continue;
      }
      try {
        await this.#recovery.recoverJob(job);
      } catch (cause) {
        this.#reportDiagnostic("dispatch_recovery_failed", runId, cause);
      }
    }
    await this.#recovery.recoverStaleJobs({
      jobIds: new Set(runIds),
      corruptJobIds: corruptRunIds,
      terminalCorruptRunIds,
      activeRunIds: new Set([
        ...this.#activeRunIds(),
        ...protectedResumeRunIds
      ]),
      // A rotating page being complete only means that page reached the end
      // of the directory. It does not prove that an older-page job vanished.
      inspectJob: (runId: string) => this.inspectQueuedRun(runId)
    });
  }

  private async inspectQueuedRun(
    runId: string
  ): Promise<NativeStudioRunRecoveryJobInspection> {
    return await this.#queue.inspect(runId);
  }
}
