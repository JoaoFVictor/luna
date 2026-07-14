import {
  RepositoryIndexCapacityError,
  type RepositoryIndexCapacityDiagnostics
} from "./repository-index-policy.js";

export type RepositoryAdmissionLease = {
  release(): void;
};

type Waiter = {
  readonly bytes: number;
  readonly resolve: (lease: RepositoryAdmissionLease) => void;
  readonly reject: (cause: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  granted: boolean;
};

type MutableLease = {
  readonly reservedBytes: number;
  released: boolean;
};

type AdmissionStats = {
  readonly admission_rejections: number;
  readonly active_operations: number;
  readonly peak_active_operations: number;
  readonly peak_queued_operations: number;
  readonly active_reserved_bytes: number;
  readonly process_accounted_bytes: number;
  readonly peak_reserved_bytes: number;
  readonly peak_process_accounted_bytes: number;
  readonly cache_evictions_for_admission: number;
};

function abortCause(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export class RepositoryIndexAdmission {
  readonly #maxOperations: number;
  readonly #maxQueued: number;
  readonly #maxProcessBytes: number;
  readonly #cacheBytes: () => number;
  readonly #evictOldestCacheEntry: () => boolean;
  readonly #waiters: Waiter[] = [];
  #activeOperations = 0;
  #reservedBytes = 0;
  #admissionRejections = 0;
  #peakActiveOperations = 0;
  #peakQueuedOperations = 0;
  #peakReservedBytes = 0;
  #peakProcessAccountedBytes = 0;
  #cacheEvictionsForAdmission = 0;

  constructor(input: {
    readonly maxOperations: number;
    readonly maxQueued: number;
    readonly maxProcessBytes: number;
    readonly cacheBytes: () => number;
    readonly evictOldestCacheEntry: () => boolean;
  }) {
    this.#maxOperations = input.maxOperations;
    this.#maxQueued = input.maxQueued;
    this.#maxProcessBytes = input.maxProcessBytes;
    this.#cacheBytes = input.cacheBytes;
    this.#evictOldestCacheEntry = input.evictOldestCacheEntry;
  }

  async acquire(bytes: number, signal: AbortSignal): Promise<RepositoryAdmissionLease> {
    signal.throwIfAborted();
    this.#assertRequest(bytes);
    if (
      this.#waiters.length === 0 &&
      this.#activeOperations < this.#maxOperations &&
      this.#makeRoom(bytes)
    ) {
      return this.#grant(bytes);
    }
    const observed = this.#waiters.length + 1;
    if (observed > this.#maxQueued) {
      this.#admissionRejections += 1;
      throw this.#capacityError("queued_operations", observed, this.#maxQueued);
    }
    return await new Promise<RepositoryAdmissionLease>((resolve, reject) => {
      const waiter: Waiter = {
        bytes,
        resolve,
        reject,
        signal,
        granted: false,
        onAbort: () => {
          if (waiter.granted) return;
          const index = this.#waiters.indexOf(waiter);
          if (index !== -1) this.#waiters.splice(index, 1);
          reject(abortCause(signal));
          this.#drain();
        }
      };
      this.#waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
      this.#peakQueuedOperations = Math.max(this.#peakQueuedOperations, this.#waiters.length);
    });
  }

  observeCacheChange(): void {
    this.#recordPeaks();
  }

  recordAdmissionCacheEviction(): void {
    this.#cacheEvictionsForAdmission += 1;
  }

  isIdle(): boolean {
    return this.#activeOperations === 0 && this.#waiters.length === 0;
  }

  reset(): void {
    if (!this.isIdle()) {
      throw new Error("Cannot reset repository admission while operations are active or queued.");
    }
    this.#reservedBytes = 0;
    this.#admissionRejections = 0;
    this.#peakActiveOperations = 0;
    this.#peakQueuedOperations = 0;
    this.#peakReservedBytes = 0;
    this.#peakProcessAccountedBytes = 0;
    this.#cacheEvictionsForAdmission = 0;
  }

  stats(): AdmissionStats & { readonly queued_operations: number } {
    return {
      admission_rejections: this.#admissionRejections,
      active_operations: this.#activeOperations,
      peak_active_operations: this.#peakActiveOperations,
      peak_queued_operations: this.#peakQueuedOperations,
      active_reserved_bytes: this.#reservedBytes,
      process_accounted_bytes: this.#reservedBytes + this.#cacheBytes(),
      peak_reserved_bytes: this.#peakReservedBytes,
      peak_process_accounted_bytes: this.#peakProcessAccountedBytes,
      cache_evictions_for_admission: this.#cacheEvictionsForAdmission,
      queued_operations: this.#waiters.length
    };
  }

  #assertRequest(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError("Repository admission bytes must be a non-negative safe integer.");
    }
    if (bytes > this.#maxProcessBytes) {
      this.#admissionRejections += 1;
      throw this.#capacityError("process_index_bytes", bytes, this.#maxProcessBytes);
    }
  }

  #makeRoom(additionalBytes: number): boolean {
    while (this.#reservedBytes + additionalBytes + this.#cacheBytes() > this.#maxProcessBytes) {
      if (!this.#evictOldestCacheEntry()) return false;
      this.#cacheEvictionsForAdmission += 1;
    }
    return true;
  }

  #grant(bytes: number): RepositoryAdmissionLease {
    const state: MutableLease = { reservedBytes: bytes, released: false };
    this.#activeOperations += 1;
    this.#reservedBytes += bytes;
    this.#recordPeaks();
    return {
      release: () => this.#release(state)
    };
  }

  #release(state: MutableLease): void {
    if (state.released) return;
    state.released = true;
    this.#activeOperations -= 1;
    this.#reservedBytes -= state.reservedBytes;
    this.#drain();
  }

  #drain(): void {
    while (this.#activeOperations < this.#maxOperations) {
      const waiter = this.#waiters[0];
      if (waiter === undefined || !this.#makeRoom(waiter.bytes)) return;
      this.#waiters.shift();
      waiter.granted = true;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(this.#grant(waiter.bytes));
    }
  }

  #recordPeaks(): void {
    this.#peakActiveOperations = Math.max(this.#peakActiveOperations, this.#activeOperations);
    this.#peakReservedBytes = Math.max(this.#peakReservedBytes, this.#reservedBytes);
    this.#peakProcessAccountedBytes = Math.max(
      this.#peakProcessAccountedBytes,
      this.#reservedBytes + this.#cacheBytes()
    );
  }

  #capacityError(
    resource: RepositoryIndexCapacityDiagnostics["resource"],
    observed: number,
    limit: number
  ): RepositoryIndexCapacityError {
    return new RepositoryIndexCapacityError(
      resource === "queued_operations"
        ? "Repository index admission queue is full."
        : "Repository index process accounting budget is exhausted.",
      { phase: "admission", resource, observed, limit }
    );
  }
}
