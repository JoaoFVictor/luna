import type { Dir } from "node:fs";
import path from "node:path";
import {
  reportStudioRunDiagnosticBestEffort,
  type StudioRunDiagnosticCode,
  type StudioRunDiagnosticSink
} from "../../application/runs/diagnostics.js";
import type {
  RunLedgerPort,
  RunReconcilerPort
} from "../../application/runs/ports.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import { HistoricalRunCandidateTracker } from "./historical-run-candidate-tracker.js";
import {
  readHistoricalRunMetadata,
  type HistoricalRunMetadata
} from "./historical-run-metadata.js";
import {
  emptyHistoricalRunReconciliationReport,
  historicalRunImportIds,
  historicalRunRecord,
  resolveHistoricalRunReconciliationOptions,
  type HistoricalRunReconciliationOptions,
  type HistoricalRunReconciliationReport,
  type MutableHistoricalRunReconciliationReport,
  type ResolvedHistoricalRunReconciliationOptions
} from "./historical-run-reconciliation.js";
import {
  closePinnedDirectory,
  configuredRootMatches,
  openPinnedRootDirectory,
  openPinnedRunDirectory,
  pinHistoricalRunRoot,
  type PinnedHistoricalRunDirectory,
  type PinnedHistoricalRunRoot
} from "./historical-run-filesystem.js";

export type {
  HistoricalRunReconciliationOptions,
  HistoricalRunReconciliationReport
} from "./historical-run-reconciliation.js";

type CandidateResult = "imported" | "known" | "retry" | "failed";

export class FilesystemHistoricalRunReconciler {
  readonly #root: string;
  readonly #reconciler: RunReconcilerPort;
  readonly #knownRuns: Pick<RunLedgerPort, "get">;
  readonly #diagnostics: StudioRunDiagnosticSink | undefined;
  readonly #now: () => Date;
  readonly #options: ResolvedHistoricalRunReconciliationOptions;
  readonly #candidates: HistoricalRunCandidateTracker;
  #pinnedRoot: PinnedHistoricalRunRoot | undefined;
  #scanDirectory: Dir | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<HistoricalRunReconciliationReport> | undefined;
  #closePromise: Promise<void> | undefined;
  #singleSlotRetryTurn = true;
  #initialized = false;
  #closed = false;

  constructor(input: {
    readonly root: string;
    readonly reconciler: RunReconcilerPort;
    readonly knownRuns: Pick<RunLedgerPort, "get">;
    readonly diagnostics?: StudioRunDiagnosticSink;
    readonly now?: () => Date;
    readonly options?: HistoricalRunReconciliationOptions;
  }) {
    this.#root = path.resolve(input.root);
    this.#reconciler = input.reconciler;
    this.#knownRuns = input.knownRuns;
    this.#diagnostics = input.diagnostics;
    this.#now = input.now ?? (() => new Date());
    this.#options = resolveHistoricalRunReconciliationOptions(
      input.options ?? {}
    );
    this.#candidates = new HistoricalRunCandidateTracker(this.#options);
  }

  async initialize(): Promise<HistoricalRunReconciliationReport> {
    if (this.#initialized || this.#closed) {
      return emptyHistoricalRunReconciliationReport();
    }
    this.#initialized = true;
    const report = await this.reconcileNow();
    this.#scheduleNext();
    return report;
  }

  async reconcileNow(): Promise<HistoricalRunReconciliationReport> {
    if (this.#closed) {
      return emptyHistoricalRunReconciliationReport();
    }
    if (this.#inFlight !== undefined) {
      return await this.#inFlight;
    }
    const operation = this.#reconcileBestEffort();
    this.#inFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.#inFlight === operation) {
        this.#inFlight = undefined;
      }
    }
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      if (this.#timer !== undefined) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
      }
      this.#closePromise = this.#finishClose();
    }
    return this.#closePromise;
  }

  async #finishClose(): Promise<void> {
    await this.#inFlight;
    await this.#closeScanDirectory();
    await this.#closePinnedRoot();
  }

  #scheduleNext(): void {
    if (this.#closed) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#runScheduledReconciliation();
    }, this.#options.intervalMs);
    this.#timer.unref();
  }

  async #runScheduledReconciliation(): Promise<void> {
    try {
      await this.reconcileNow();
    } finally {
      this.#scheduleNext();
    }
  }

  async #reconcileBestEffort(): Promise<HistoricalRunReconciliationReport> {
    try {
      return await this.#scanRoot();
    } catch {
      this.#reportDiagnostic("historical_scan_failed");
      return emptyHistoricalRunReconciliationReport();
    }
  }

  #reportDiagnostic(code: StudioRunDiagnosticCode, runId?: string): void {
    let occurredAt: string;
    try {
      occurredAt = this.#now().toISOString();
    } catch {
      occurredAt = new Date().toISOString();
    }
    reportStudioRunDiagnosticBestEffort(this.#diagnostics, {
      code,
      component: "historical_reconciler",
      occurred_at: occurredAt,
      ...(runId === undefined ? {} : { run_id: runId })
    });
  }

  async #scanRoot(): Promise<HistoricalRunReconciliationReport> {
    const root = await this.#ensurePinnedRoot();
    if (root === undefined) {
      return emptyHistoricalRunReconciliationReport();
    }
    const report = { ...emptyHistoricalRunReconciliationReport() };
    const attempted = new Set<string>();
    await this.#retryPending(root, report, attempted);
    const directory = await this.#openScanDirectory(root);
    if (directory === undefined) {
      this.#reportDiagnostic("historical_scan_failed");
      return report;
    }
    let reachedEnd = false;
    try {
      while (
        !this.#closed &&
        report.examinedEntries < this.#options.maxRootEntries &&
        report.examinedRunDirectories < this.#options.maxRunDirectories
      ) {
        const entry = await directory.read();
        if (entry === null) {
          reachedEnd = true;
          break;
        }
        report.examinedEntries += 1;
        const runId = RunOpaqueIdSchema.safeParse(entry.name);
        if (
          !runId.success ||
          runId.data !== entry.name ||
          entry.isSymbolicLink()
        ) {
          report.skipped += 1;
          continue;
        }
        if (attempted.has(runId.data)) {
          continue;
        }
        attempted.add(runId.data);
        const candidate = await openPinnedRunDirectory(root, runId.data);
        if (candidate === undefined) {
          report.skipped += 1;
          continue;
        }
        report.examinedRunDirectories += 1;
        try {
          const result = await this.#reconcileCandidate(candidate, runId.data);
          this.#applyCandidateResult(report, runId.data, result);
        } finally {
          await closePinnedDirectory(candidate);
        }
      }
      return report;
    } catch (cause) {
      await this.#closeScanDirectory(directory);
      throw cause;
    } finally {
      if (reachedEnd) {
        await this.#closeScanDirectory(directory);
      }
    }
  }

  async #ensurePinnedRoot(): Promise<PinnedHistoricalRunRoot | undefined> {
    if (
      this.#pinnedRoot !== undefined &&
      !(await configuredRootMatches(this.#root, this.#pinnedRoot))
    ) {
      await this.#closeScanDirectory();
      await this.#closePinnedRoot();
    }
    if (this.#pinnedRoot === undefined) {
      this.#pinnedRoot = await pinHistoricalRunRoot(this.#root);
    }
    return this.#pinnedRoot;
  }

  async #openScanDirectory(
    root: PinnedHistoricalRunRoot
  ): Promise<Dir | undefined> {
    if (this.#scanDirectory !== undefined) {
      return this.#scanDirectory;
    }
    this.#scanDirectory = await openPinnedRootDirectory(root);
    return this.#scanDirectory;
  }

  async #closeScanDirectory(expected?: Dir): Promise<void> {
    if (
      this.#scanDirectory === undefined ||
      (expected !== undefined && expected !== this.#scanDirectory)
    ) {
      return;
    }
    const directory = this.#scanDirectory;
    this.#scanDirectory = undefined;
    await directory.close().catch(() => undefined);
  }

  async #closePinnedRoot(): Promise<void> {
    const root = this.#pinnedRoot;
    this.#pinnedRoot = undefined;
    await closePinnedDirectory(root);
  }

  async #retryPending(
    root: PinnedHistoricalRunRoot,
    report: MutableHistoricalRunReconciliationReport,
    attempted: Set<string>
  ): Promise<void> {
    const pendingEntries = [...this.#candidates.pendingEntries()];
    for (const [runId] of pendingEntries) {
      // A pending candidate is owned by the retry queue for this entire pass.
      // Mark every pending id before applying the due/batch limits so the root
      // scan cannot bypass either the candidate's backoff or retry budget.
      attempted.add(runId);
    }
    const retryLimit = this.#pendingRetryLimit(pendingEntries.length);
    let retried = 0;
    const nowMs = this.#now().getTime();
    for (const [runId, pending] of pendingEntries) {
      if (
        this.#closed ||
        retried >= retryLimit ||
        report.examinedRunDirectories >= this.#options.maxRunDirectories
      ) {
        break;
      }
      if (pending.retryAtMs > nowMs) {
        continue;
      }
      retried += 1;
      const candidate = await openPinnedRunDirectory(root, runId);
      if (candidate === undefined) {
        this.#candidates.forgetPending(runId);
        continue;
      }
      report.examinedRunDirectories += 1;
      try {
        const result = await this.#reconcileCandidate(candidate, runId);
        this.#applyCandidateResult(report, runId, result);
      } finally {
        await closePinnedDirectory(candidate);
      }
    }
  }

  #pendingRetryLimit(pendingCount: number): number {
    if (pendingCount === 0) {
      return 0;
    }
    if (this.#options.maxRunDirectories === 1) {
      const retryThisPass = this.#singleSlotRetryTurn;
      this.#singleSlotRetryTurn = !this.#singleSlotRetryTurn;
      return retryThisPass ? 1 : 0;
    }
    // Leave at least one directory slot for forward progress of the root
    // cursor. Pending retries retain their own bounded share on every pass.
    return Math.min(
      this.#options.pendingRetryBatchSize,
      this.#options.maxRunDirectories - 1
    );
  }

  #applyCandidateResult(
    report: MutableHistoricalRunReconciliationReport,
    runId: string,
    result: CandidateResult
  ): void {
    if (result === "imported") {
      this.#candidates.forgetPending(runId);
      report.imported += 1;
      return;
    }
    if (result === "known") {
      this.#candidates.forgetPending(runId);
      report.alreadyKnown += 1;
      return;
    }
    this.#candidates.queuePending(runId, this.#now().getTime());
    report.skipped += 1;
  }

  async #reconcileCandidate(
    directory: PinnedHistoricalRunDirectory,
    runId: string
  ): Promise<CandidateResult> {
    if (this.#candidates.isKnown(runId)) {
      return "known";
    }
    try {
      if (await this.#knownRuns.get(runId) !== undefined) {
        this.#candidates.remember(runId);
        return "known";
      }
    } catch {
      this.#reportDiagnostic("historical_lookup_failed", runId);
      return "failed";
    }
    let metadata: HistoricalRunMetadata | undefined;
    try {
      metadata = await readHistoricalRunMetadata({
        directory,
        expectedRunId: runId,
        options: this.#options
      });
    } catch {
      this.#reportDiagnostic("historical_import_failed", runId);
      return "failed";
    }
    if (metadata === undefined) {
      return "retry";
    }
    try {
      const record = historicalRunRecord(metadata);
      const ids = historicalRunImportIds(record);
      const result = await this.#reconciler.importHistorical({
        record,
        transition_id: ids.transitionId,
        event_id: ids.eventId
      });
      this.#candidates.remember(runId);
      return result.applied ? "imported" : "known";
    } catch {
      this.#reportDiagnostic("historical_import_failed", runId);
      return "failed";
    }
  }

}
