type PendingCandidate = {
  readonly attempts: number;
  readonly retryAtMs: number;
};

export class HistoricalRunCandidateTracker {
  readonly #trackedRunLimit: number;
  readonly #pendingRunLimit: number;
  readonly #pendingRetryBaseMs: number;
  readonly #trackedRuns = new Map<string, true>();
  readonly #pendingRuns = new Map<string, PendingCandidate>();

  constructor(options: {
    readonly trackedRunLimit: number;
    readonly pendingRunLimit: number;
    readonly pendingRetryBaseMs: number;
  }) {
    this.#trackedRunLimit = options.trackedRunLimit;
    this.#pendingRunLimit = options.pendingRunLimit;
    this.#pendingRetryBaseMs = options.pendingRetryBaseMs;
  }

  isKnown(runId: string): boolean {
    return this.#trackedRuns.has(runId);
  }

  pendingEntries(): IterableIterator<[string, PendingCandidate]> {
    return this.#pendingRuns.entries();
  }

  forgetPending(runId: string): void {
    this.#pendingRuns.delete(runId);
  }

  queuePending(runId: string, nowMs: number): void {
    const attempts = (this.#pendingRuns.get(runId)?.attempts ?? 0) + 1;
    const multiplier = 2 ** Math.min(attempts - 1, 10);
    const delay = Math.min(
      this.#pendingRetryBaseMs * multiplier,
      3_600_000
    );
    this.#pendingRuns.delete(runId);
    this.#pendingRuns.set(runId, {
      attempts,
      retryAtMs: nowMs + delay
    });
    trimOldest(this.#pendingRuns, this.#pendingRunLimit);
  }

  remember(runId: string): void {
    this.#pendingRuns.delete(runId);
    this.#trackedRuns.delete(runId);
    this.#trackedRuns.set(runId, true);
    trimOldest(this.#trackedRuns, this.#trackedRunLimit);
  }
}

function trimOldest<Value>(entries: Map<string, Value>, limit: number): void {
  while (entries.size > limit) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) {
      return;
    }
    entries.delete(oldest);
  }
}
