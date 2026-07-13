import path from "node:path";
import { buildRepositoryIndex } from "./repository-index-builder.js";
import { repositorySnapshotIdentity } from "./repository-index-inventory.js";
import {
  RepositoryIndexCapacityError,
  RepositoryIndexSnapshotChangedError,
  REPOSITORY_INDEX_RESOURCE_POLICY,
  normalizedRepositoryContextPolicy,
  repositoryIndexPolicyMaterial,
  type RepositoryContextIndexPolicy,
  type RepositoryIndexCapacityDiagnostics
} from "./repository-index-policy.js";
import type { RepositoryIndex } from "./repository-index-types.js";
import {
  RepositoryIndexAdmission,
  type RepositoryAdmissionLease
} from "./repository-index-admission.js";

export { RepositoryIndexCapacityError };
export type { RepositoryIndexCapacityDiagnostics };
export type {
  RepositoryIndex,
  RepositoryIndexBuildStats,
  RepositoryIndexCoverage,
  RepositoryIndexSnapshot
} from "./repository-index-types.js";

type CacheEntry = {
  readonly promise: Promise<RepositoryIndex>;
  bytes: number;
};

type RootFlight = {
  promise: Promise<RepositoryIndex>;
  readonly controller: AbortController;
  consumers: number;
  settled: boolean;
};

const snapshotCache = new Map<string, CacheEntry>();
const rootFlights = new Map<string, RootFlight>();
let cacheBytes = 0;
const cacheStats = {
  hits: 0,
  misses: 0,
  builds: 0,
  failed_builds: 0,
  capacity_rejections: 0,
  snapshot_conflicts: 0,
  snapshot_retries: 0,
  initial_snapshots: 0,
  snapshot_fingerprinted_bytes: 0,
  root_flight_hits: 0,
  active_builds: 0,
  peak_active_builds: 0
};
const MAX_SNAPSHOT_RETRIES = 1;

function removeCacheEntry(key: string): void {
  const entry = snapshotCache.get(key);
  if (entry !== undefined) {
    cacheBytes -= entry.bytes;
    snapshotCache.delete(key);
  }
}

function evictOldestSettledCacheEntry(): boolean {
  const settled = [...snapshotCache.entries()].find(([, entry]) => entry.bytes > 0);
  if (settled === undefined) return false;
  removeCacheEntry(settled[0]);
  return true;
}

const admission = new RepositoryIndexAdmission({
  maxOperations: REPOSITORY_INDEX_RESOURCE_POLICY.max_concurrent_index_operations,
  maxQueued: REPOSITORY_INDEX_RESOURCE_POLICY.max_queued_index_operations,
  maxProcessBytes: REPOSITORY_INDEX_RESOURCE_POLICY.max_process_index_bytes,
  cacheBytes: () => cacheBytes,
  evictOldestCacheEntry: evictOldestSettledCacheEntry
});

function enforceCacheBudget(): void {
  while (
    cacheBytes > REPOSITORY_INDEX_RESOURCE_POLICY.max_cache_bytes ||
    cacheBytes + admission.stats().active_reserved_bytes >
      REPOSITORY_INDEX_RESOURCE_POLICY.max_process_index_bytes
  ) {
    const overProcess = cacheBytes + admission.stats().active_reserved_bytes >
      REPOSITORY_INDEX_RESOURCE_POLICY.max_process_index_bytes;
    const oldest = snapshotCache.entries().next().value as [string, CacheEntry] | undefined;
    if (oldest === undefined) {
      return;
    }
    if (oldest[1].bytes === 0) {
      const settled = [...snapshotCache.entries()].find(([, entry]) => entry.bytes > 0);
      if (settled === undefined) {
        return;
      }
      removeCacheEntry(settled[0]);
    } else {
      removeCacheEntry(oldest[0]);
    }
    if (overProcess) admission.recordAdmissionCacheEviction();
  }
  admission.observeCacheChange();
}

function abortCause(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export async function acquireRepositoryQuerySlot(
  signal: AbortSignal
): Promise<() => void> {
  const lease = await admission.acquire(
    REPOSITORY_INDEX_RESOURCE_POLICY.estimated_query_operation_bytes,
    signal
  );
  return () => lease.release();
}

async function repositoryIndexAttempt(
  root: string,
  policy: RepositoryContextIndexPolicy,
  retriesRemaining: number,
  signal: AbortSignal
): Promise<RepositoryIndex> {
  signal.throwIfAborted();
  let identity;
  try {
    cacheStats.initial_snapshots += 1;
    identity = await repositorySnapshotIdentity(root, policy, signal);
    cacheStats.snapshot_fingerprinted_bytes += identity.fingerprintedContentBytes;
  } catch (cause) {
    cacheStats.failed_builds += 1;
    if (cause instanceof RepositoryIndexCapacityError) {
      cacheStats.capacity_rejections += 1;
    }
    if (cause instanceof RepositoryIndexSnapshotChangedError) {
      cacheStats.snapshot_conflicts += 1;
      if (retriesRemaining > 0) {
        cacheStats.snapshot_retries += 1;
        return await repositoryIndexAttempt(root, policy, retriesRemaining - 1, signal);
      }
    }
    throw cause;
  }
  const cacheKey = `${root}\0${identity.id}`;
  const cached = snapshotCache.get(cacheKey);
  if (cached !== undefined) {
    cacheStats.hits += 1;
    snapshotCache.delete(cacheKey);
    snapshotCache.set(cacheKey, cached);
    try {
      return await cached.promise;
    } catch (cause) {
      if (cause instanceof RepositoryIndexSnapshotChangedError && retriesRemaining > 0) {
        cacheStats.snapshot_retries += 1;
        return await repositoryIndexAttempt(root, policy, retriesRemaining - 1, signal);
      }
      throw cause;
    }
  }

  cacheStats.misses += 1;
  cacheStats.builds += 1;
  const pending = (async () => {
    cacheStats.active_builds += 1;
    cacheStats.peak_active_builds = Math.max(
      cacheStats.peak_active_builds,
      cacheStats.active_builds
    );
    try {
      const index = await buildRepositoryIndex(root, identity, signal);
      signal.throwIfAborted();
      const validatedIdentity = await repositorySnapshotIdentity(root, policy, signal);
      if (validatedIdentity.id !== identity.id) {
        throw new RepositoryIndexSnapshotChangedError();
      }
      return index;
    } finally {
      cacheStats.active_builds -= 1;
    }
  })();
  const entry: CacheEntry = { promise: pending, bytes: 0 };
  snapshotCache.set(cacheKey, entry);
  try {
    const index = await pending;
    signal.throwIfAborted();
    if (snapshotCache.get(cacheKey) === entry) {
      entry.bytes = index.stats.retained_index_bytes;
      cacheBytes += entry.bytes;
      if (entry.bytes > REPOSITORY_INDEX_RESOURCE_POLICY.max_cache_bytes) {
        removeCacheEntry(cacheKey);
      } else {
        enforceCacheBudget();
      }
    }
    return index;
  } catch (cause) {
    cacheStats.failed_builds += 1;
    if (cause instanceof RepositoryIndexCapacityError) {
      cacheStats.capacity_rejections += 1;
    }
    if (cause instanceof RepositoryIndexSnapshotChangedError) {
      cacheStats.snapshot_conflicts += 1;
    }
    removeCacheEntry(cacheKey);
    if (cause instanceof RepositoryIndexSnapshotChangedError && retriesRemaining > 0) {
      cacheStats.snapshot_retries += 1;
      return await repositoryIndexAttempt(root, policy, retriesRemaining - 1, signal);
    }
    throw cause;
  }
}

async function runRootIndexOperation(
  root: string,
  policy: RepositoryContextIndexPolicy,
  signal: AbortSignal
): Promise<RepositoryIndex> {
  let lease: RepositoryAdmissionLease;
  try {
    lease = await admission.acquire(
      REPOSITORY_INDEX_RESOURCE_POLICY.estimated_index_operation_bytes,
      signal
    );
  } catch (cause) {
    cacheStats.failed_builds += 1;
    if (cause instanceof RepositoryIndexCapacityError) {
      cacheStats.capacity_rejections += 1;
    }
    throw cause;
  }
  try {
    return await repositoryIndexAttempt(root, policy, MAX_SNAPSHOT_RETRIES, signal);
  } finally {
    lease.release();
  }
}

function sharedFlight(
  key: string,
  root: string,
  policy: RepositoryContextIndexPolicy
): RootFlight {
  const controller = new AbortController();
  const flight: RootFlight = {
    promise: Promise.resolve(undefined as never),
    controller,
    consumers: 0,
    settled: false
  };
  flight.promise = runRootIndexOperation(root, policy, controller.signal).finally(() => {
    flight.settled = true;
    if (rootFlights.get(key) === flight) {
      rootFlights.delete(key);
    }
  });
  // If every consumer aborts, the shared operation may reject after callers
  // have detached. Keep that rejection observed without changing its outcome.
  void flight.promise.catch(() => undefined);
  rootFlights.set(key, flight);
  return flight;
}

async function consumeFlight(flight: RootFlight, signal?: AbortSignal): Promise<RepositoryIndex> {
  signal?.throwIfAborted();
  flight.consumers += 1;
  let onAbort: (() => void) | undefined;
  try {
    if (signal === undefined) {
      return await flight.promise;
    }
    return await new Promise<RepositoryIndex>((resolve, reject) => {
      onAbort = () => reject(abortCause(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      void flight.promise.then(resolve, reject);
    });
  } finally {
    if (onAbort !== undefined) {
      signal?.removeEventListener("abort", onAbort);
    }
    flight.consumers -= 1;
    if (flight.consumers === 0 && !flight.settled) {
      flight.controller.abort(new DOMException("All index consumers aborted.", "AbortError"));
    }
  }
}

export async function repositoryIndex(input: {
  readonly root: string;
  readonly policy?: RepositoryContextIndexPolicy;
  readonly signal?: AbortSignal;
}): Promise<RepositoryIndex> {
  input.signal?.throwIfAborted();
  const root = path.resolve(input.root);
  const policy = normalizedRepositoryContextPolicy(input.policy);
  const key = `${root}\0${repositoryIndexPolicyMaterial(policy)}`;
  let flight = rootFlights.get(key);
  if (flight !== undefined) {
    cacheStats.root_flight_hits += 1;
  } else {
    flight = sharedFlight(key, root, policy);
  }
  return await consumeFlight(flight, input.signal);
}

export function repositoryIndexResourcePolicy(): Readonly<typeof REPOSITORY_INDEX_RESOURCE_POLICY> {
  return REPOSITORY_INDEX_RESOURCE_POLICY;
}

export function clearRepositoryIndexCache(): void {
  if (
    !admission.isIdle() ||
    rootFlights.size !== 0
  ) {
    throw new Error("Cannot clear the repository index cache while operations are active or queued.");
  }
  snapshotCache.clear();
  cacheBytes = 0;
  admission.reset();
  for (const key of Object.keys(cacheStats) as Array<keyof typeof cacheStats>) {
    cacheStats[key] = 0;
  }
}

export function repositoryIndexCacheStats(): Readonly<
  typeof cacheStats & ReturnType<RepositoryIndexAdmission["stats"]> & {
  readonly entries: number;
  readonly bytes: number;
  readonly root_flights: number;
}> {
  const admissionStats = admission.stats();
  return {
    ...cacheStats,
    ...admissionStats,
    entries: snapshotCache.size,
    bytes: cacheBytes,
    root_flights: rootFlights.size
  };
}
