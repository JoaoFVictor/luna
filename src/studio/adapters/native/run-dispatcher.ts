import { randomBytes } from "node:crypto";
import path from "node:path";
import type { NativeLunaPlatformRegistrations } from "../../../platform/native/native-platform-registrations.js";
import type { NativeWorkflowRunInput } from "../../../runtime/composition/target-executor.js";
import {
  createProcessWarningRunDiagnosticSink,
  reportStudioRunDiagnosticBestEffort,
  type StudioRunDiagnosticCode,
  type StudioRunDiagnosticSink
} from "../../application/runs/diagnostics.js";
import type { RunGraphSnapshotStorePort } from "../../application/runs/graph-snapshot.js";
import { studioRunLaunchError } from "../../application/runs/launch-errors.js";
import type {
  StudioRunDispatchCommand,
  StudioRunDispatcherPort
} from "../../application/runs/launch-ports.js";
import type { RunLedgerPort } from "../../application/runs/ports.js";
import type { StudioRunDispatchReceipt } from "../../contracts/run-launch.js";
import { FilesystemRunGraphStore } from "../filesystem/run-graph-store.js";
import { NativeStudioRunDispatchQueue } from "../filesystem/run-dispatch-queue.js";
import {
  NativeStudioRunTerminalJournal,
  type NativeStudioRunTerminalJournalPort
} from "../filesystem/run-terminal-journal.js";
import {
  NativeStudioRunRecoveryJournal,
  type NativeStudioRunRecoveryJournalPort
} from "../filesystem/run-recovery-journal.js";
import { NativeStudioRunExecutor } from "./run-dispatch-execution.js";
import { NativeStudioRunFinalizer } from "./run-finalizer.js";
import {
  NativeStudioRunLease,
  type NativeStudioRunRecoveryClaim
} from "./run-dispatch-lease.js";
import { buildNativeStudioQueuedRunMaterial } from "./run-dispatch-material.js";
import { nativeStudioRunDispatchIdentity } from "./run-dispatch-material.js";
import type { NativeStudioRunDispatchPayload } from "./run-snapshot-contracts.js";
import { nativeStudioCheckpointReplayIsSafe } from "./run-recovery-safety.js";
import { NativeStudioRunDispatchAdoption } from "./run-dispatch-adoption.js";
import { NativeStudioRunRecoverySupervisor } from "./run-recovery-supervisor.js";
import { NativeStudioRunTerminalJobCleanup } from "./run-terminal-job-cleanup.js";
import { createNativeStudioCapabilityCatalog } from "./capability-catalog.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_ORPHAN_THRESHOLD_MS = 60_000;
const MAX_ORPHAN_THRESHOLD_MS = 24 * 60 * 60 * 1_000;

type DispatcherPlatform = Pick<
  NativeLunaPlatformRegistrations,
  | "capabilityRegistry"
  | "workflowBuiltIns"
  | "taskProviderBuiltIns"
>;

type RunWorkflow = (
  input: NativeWorkflowRunInput
) => Promise<unknown>;

export type NativeStudioRunDispatcherOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly queueRoot?: string;
  readonly graphRoot?: string;
  readonly graphStore?: RunGraphSnapshotStorePort;
  readonly terminalJournal?: NativeStudioRunTerminalJournalPort;
  readonly recoveryJournal?: NativeStudioRunRecoveryJournalPort;
  readonly ledger: RunLedgerPort;
  readonly platform: DispatcherPlatform;
  readonly runWorkflow: RunWorkflow;
  readonly now?: () => number;
  readonly ownerId?: string;
  readonly heartbeatIntervalMs?: number;
  readonly orphanThresholdMs?: number;
  readonly schedule?: (task: () => void) => void;
  readonly runDiagnostics?: StudioRunDiagnosticSink;
  /** Test-only fault observation hook. Production diagnostics use runDiagnostics. */
  readonly onBackgroundError?: (cause: unknown) => void;
};

export class NativeStudioRunDispatcher
  implements StudioRunDispatcherPort<NativeStudioRunDispatchPayload>
{
  readonly #ledger: RunLedgerPort;
  readonly #queue: NativeStudioRunDispatchQueue;
  readonly #graphStore: RunGraphSnapshotStorePort;
  readonly #recoveryJournal: NativeStudioRunRecoveryJournalPort;
  readonly #executor: NativeStudioRunExecutor;
  readonly #adoption: NativeStudioRunDispatchAdoption;
  readonly #terminalJobCleanup: NativeStudioRunTerminalJobCleanup;
  readonly #recoverySupervisor: NativeStudioRunRecoverySupervisor;
  readonly #now: () => number;
  readonly #ownerId: string;
  readonly #heartbeatIntervalMs: number;
  readonly #scheduleTask: (task: () => void) => void;
  readonly #runDiagnostics: StudioRunDiagnosticSink | undefined;
  readonly #onBackgroundError: ((cause: unknown) => void) | undefined;
  readonly #active = new Map<string, Promise<void>>();
  #initialized = false;
  #closed = false;

  constructor(options: NativeStudioRunDispatcherOptions) {
    const projectRoot = path.resolve(options.projectRoot);
    const configRoot = path.resolve(options.configRoot);
    this.#ledger = options.ledger;
    const queueRoot = options.queueRoot ?? path.join(
      projectRoot,
      ".luna",
      "studio",
      "run-dispatch"
    );
    this.#queue = new NativeStudioRunDispatchQueue({
      root: queueRoot
    });
    this.#graphStore = options.graphStore ?? new FilesystemRunGraphStore({
      root: options.graphRoot ?? path.join(
        projectRoot,
        ".luna",
        "studio",
        "run-graphs"
      )
    });
    this.#now = options.now ?? Date.now;
    this.#ownerId = options.ownerId ??
      `studio-worker-${randomBytes(12).toString("hex")}`;
    this.#heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#scheduleTask = options.schedule ?? ((task) => setImmediate(task));
    this.#runDiagnostics = options.runDiagnostics ??
      (options.onBackgroundError === undefined
        ? createProcessWarningRunDiagnosticSink()
        : undefined);
    this.#onBackgroundError = options.onBackgroundError;
    const catalogFingerprint = createNativeStudioCapabilityCatalog(
      options.platform
    ).technical_fingerprint;
    if (
      !Number.isSafeInteger(this.#heartbeatIntervalMs) ||
      this.#heartbeatIntervalMs < 1_000 ||
      this.#heartbeatIntervalMs > MAX_HEARTBEAT_INTERVAL_MS
    ) {
      throw new TypeError(
        "Native Studio dispatcher heartbeat interval must be 1000..60000ms"
      );
    }
    const orphanThresholdMs =
      options.orphanThresholdMs ?? DEFAULT_ORPHAN_THRESHOLD_MS;
    if (
      !Number.isSafeInteger(orphanThresholdMs) ||
      orphanThresholdMs < this.#heartbeatIntervalMs * 3 ||
      orphanThresholdMs > MAX_ORPHAN_THRESHOLD_MS
    ) {
      throw new TypeError(
        "Native Studio orphan threshold must be at least three heartbeat intervals and at most 24h"
      );
    }
    const recoveryIntervalMs = Math.max(
      1_000,
      Math.min(this.#heartbeatIntervalMs, Math.floor(orphanThresholdMs / 3))
    );
    const finalizer = new NativeStudioRunFinalizer({
      ledger: this.#ledger,
      graphStore: this.#graphStore,
      journal: options.terminalJournal ?? new NativeStudioRunTerminalJournal({
        queueRoot
      })
    });
    this.#recoveryJournal = options.recoveryJournal ??
      new NativeStudioRunRecoveryJournal({ queueRoot });
    this.#executor = new NativeStudioRunExecutor({
      projectRoot,
      configRoot,
      catalogFingerprint,
      queue: this.#queue,
      graphStore: this.#graphStore,
      finalizer,
      recoveryJournal: this.#recoveryJournal,
      runWorkflow: options.runWorkflow
    });
    const reportDiagnostic = (
      code: "dispatch_terminal_cleanup_failed" | "dispatch_recovery_failed",
      runId: string | undefined,
      cause: unknown
    ) => this.reportDiagnostic(code, runId, cause);
    this.#terminalJobCleanup = new NativeStudioRunTerminalJobCleanup({
      ledger: this.#ledger,
      queue: this.#queue,
      finalizer,
      reportDiagnostic
    });
    this.#adoption = new NativeStudioRunDispatchAdoption({
      ledger: this.#ledger,
      queue: this.#queue,
      cleanup: this.#terminalJobCleanup,
      reportDiagnostic
    });
    this.#recoverySupervisor = new NativeStudioRunRecoverySupervisor({
      queue: this.#queue,
      ledger: this.#ledger,
      finalizer,
      recoveryJournal: this.#recoveryJournal,
      now: this.#now,
      orphanThresholdMs,
      recoveryIntervalMs,
      activeRunIds: () => new Set(this.#active.keys()),
      scheduleQueuedRun: (runId) => this.schedule(runId),
      scheduleRecoveryRun: (claim) => this.schedule(claim.run_id, claim),
      cleanup: this.#terminalJobCleanup,
      reportDiagnostic
    });
  }

  async initialize(): Promise<void> {
    if (this.#initialized) {
      return;
    }
    if (this.#closed) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Native run dispatcher is closed"
      );
    }
    await Promise.all([
      this.#queue.initialize(),
      this.#graphStore.initialize()
    ]);
    await this.#recoverySupervisor.start();
    this.#initialized = true;
  }

  async dispatch(
    command: StudioRunDispatchCommand<NativeStudioRunDispatchPayload>
  ): Promise<StudioRunDispatchReceipt> {
    if (!this.#initialized || this.#closed) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Native run dispatcher is unavailable"
      );
    }
    const identity = nativeStudioRunDispatchIdentity(command);
    const previouslyTerminal = await this.#adoption.resolve(
      command,
      identity
    );
    if (previouslyTerminal !== undefined) {
      return previouslyTerminal;
    }

    const material = buildNativeStudioQueuedRunMaterial(command);
    const accepted = await this.#queue.accept(
      material,
      command.dispatchPayload.snapshot
    );
    const terminalAfterQueue = await this.#adoption.resolve(
      command,
      identity,
      {
        runId: accepted.job.run_id,
        createdByRetry: accepted.created
      }
    );
    if (terminalAfterQueue !== undefined) {
      return terminalAfterQueue;
    }
    try {
      await this.#ledger.preallocate(accepted.job.preallocation);
    } catch (cause) {
      const terminalAfterPreallocation = await this.#adoption.resolve(
        command,
        identity,
        {
          runId: accepted.job.run_id,
          createdByRetry: accepted.created
        }
      );
      if (terminalAfterPreallocation !== undefined) {
        return terminalAfterPreallocation;
      }
      this.schedulePreallocationRecovery(accepted.job.run_id);
      throw cause;
    }
    this.schedule(accepted.job.run_id);
    return {
      accepted: true,
      dispatch_status: "queued",
      run_id: accepted.job.run_id,
      // The immutable job retains the first accepted plan for ledger audit.
      // An exact idempotency retry may use a newly confirmed plan, so its
      // receipt must bind to this command while adopting the original run.
      plan_id: command.planId,
      execution_snapshot_hash: accepted.job.execution_snapshot_hash,
      accepted_at: accepted.job.accepted_at
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#recoverySupervisor.close();
    await Promise.allSettled(this.#active.values());
  }

  private schedule(
    runId: string,
    recoveryClaim?: NativeStudioRunRecoveryClaim
  ): void {
    if (this.#closed || this.#active.has(runId)) {
      return;
    }
    this.#scheduleTask(() => {
      if (this.#closed || this.#active.has(runId)) {
        return;
      }
      const execution = this.execute(runId, recoveryClaim);
      this.#active.set(runId, execution);
      void execution
        .catch((cause) => {
          this.reportDiagnostic("dispatch_execution_failed", runId, cause);
        })
        .finally(() => this.#active.delete(runId));
    });
  }

  private schedulePreallocationRecovery(runId: string): void {
    this.#scheduleTask(() => {
      if (this.#closed) {
        return;
      }
      void this.#queue.read(runId)
        .then(async (job) => {
          await this.#ledger.preallocate(job.preallocation);
          this.schedule(runId);
        })
        .catch((cause) => {
          this.reportDiagnostic("dispatch_recovery_failed", runId, cause);
        });
    });
  }

  private async execute(
    runId: string,
    recoveryClaim?: NativeStudioRunRecoveryClaim
  ): Promise<void> {
    const job = await this.#queue.read(runId);
    const record = await this.#ledger.get(runId);
    if (
      record === undefined ||
      (recoveryClaim === undefined
        ? record.dispatch_status !== "queued"
        : record.dispatch_status !== "started" ||
          record.run_status !== "running")
    ) {
      return;
    }
    if (record.execution_snapshot_hash !== job.execution_snapshot_hash) {
      throw studioRunLaunchError(
        "studio_run_dispatch_failed",
        "Native run job no longer matches its ledger execution snapshot"
      );
    }
    if (recoveryClaim !== undefined) {
      const intent = await this.#recoveryJournal.read(runId);
      if (
        intent === undefined ||
        intent.run_id !== job.run_id ||
        intent.execution_snapshot_hash !== job.execution_snapshot_hash ||
        intent.intent_hash !== recoveryClaim.recovery_intent_hash ||
        !nativeStudioCheckpointReplayIsSafe(job)
      ) {
        throw studioRunLaunchError(
          "studio_run_dispatch_failed",
          "Native run recovery intent is no longer exact and replay-safe"
        );
      }
    }
    const controller = new AbortController();
    const lease = new NativeStudioRunLease({
      onHeartbeatError: (cause) => {
        controller.abort(cause);
        this.reportDiagnostic("dispatch_heartbeat_failed", runId, cause);
      },
      ledger: this.#ledger,
      runId,
      ownerId: this.#ownerId,
      now: this.#now,
      heartbeatIntervalMs: this.#heartbeatIntervalMs
    });
    const preparingRecord = recoveryClaim === undefined
      ? await lease.prepare()
      : await lease.claimRecovery(recoveryClaim);
    lease.startHeartbeat();
    try {
      await this.#executor.execute(
        job,
        preparingRecord,
        lease,
        controller.signal
      );
    } finally {
      await this.#terminalJobCleanup.removeIfSafe(runId);
    }
  }

  private reportDiagnostic(
    code: StudioRunDiagnosticCode,
    runId: string | undefined,
    cause: unknown
  ): void {
    reportStudioRunDiagnosticBestEffort(this.#runDiagnostics, {
      code,
      component: "dispatcher",
      occurred_at: diagnosticTimestamp(this.#now),
      ...(runId === undefined ? {} : { run_id: runId })
    });
    try {
      this.#onBackgroundError?.(cause);
    } catch {
      // Test-only observation must not change dispatcher semantics.
    }
  }
}

function diagnosticTimestamp(now: () => number): string {
  try {
    const value = now();
    if (Number.isSafeInteger(value) && value >= 0) {
      return new Date(value).toISOString();
    }
  } catch {
    // A broken runtime clock is itself reportable and must not break reporting.
  }
  return new Date().toISOString();
}
