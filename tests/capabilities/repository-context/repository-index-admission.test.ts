import { describe, expect, it } from "vitest";
import { RepositoryIndexAdmission } from
  "../../../src/capabilities/repository-context/repository-index-admission.js";
import { RepositoryIndexCapacityError } from
  "../../../src/capabilities/repository-context/repository-index-policy.js";

describe("repository index weighted admission", () => {
  it("evicts retained cache before admitting weighted work and never exceeds its accounting cap", async () => {
    let cacheBytes = 40;
    const admission = new RepositoryIndexAdmission({
      maxOperations: 2,
      maxQueued: 2,
      maxProcessBytes: 100,
      cacheBytes: () => cacheBytes,
      evictOldestCacheEntry: () => {
        if (cacheBytes === 0) return false;
        cacheBytes = 0;
        return true;
      }
    });
    const signal = new AbortController().signal;

    const first = await admission.acquire(60, signal);
    const second = await admission.acquire(40, signal);

    expect(admission.stats()).toMatchObject({
      active_operations: 2,
      active_reserved_bytes: 100,
      process_accounted_bytes: 100,
      peak_process_accounted_bytes: 100,
      cache_evictions_for_admission: 1
    });
    second.release();
    first.release();
    expect(admission.stats()).toMatchObject({
      active_operations: 0,
      active_reserved_bytes: 0,
      process_accounted_bytes: 0
    });
  });

  it("preserves FIFO order and lets an aborted oversized head unblock the next fitting waiter", async () => {
    const admission = new RepositoryIndexAdmission({
      maxOperations: 2,
      maxQueued: 2,
      maxProcessBytes: 100,
      cacheBytes: () => 0,
      evictOldestCacheEntry: () => false
    });
    const signal = new AbortController().signal;
    const active = await admission.acquire(60, signal);
    const blockedController = new AbortController();
    const blocked = admission.acquire(50, blockedController.signal);
    const fitting = admission.acquire(30, signal);

    expect(admission.stats().queued_operations).toBe(2);
    blockedController.abort();
    await expect(blocked).rejects.toMatchObject({ name: "AbortError" });
    const granted = await fitting;
    expect(admission.stats()).toMatchObject({
      active_operations: 2,
      queued_operations: 0,
      active_reserved_bytes: 90,
      process_accounted_bytes: 90
    });

    granted.release();
    active.release();
  });

  it("rejects a single reservation larger than the global accounting budget", async () => {
    const admission = new RepositoryIndexAdmission({
      maxOperations: 1,
      maxQueued: 1,
      maxProcessBytes: 100,
      cacheBytes: () => 0,
      evictOldestCacheEntry: () => false
    });

    await expect(admission.acquire(101, new AbortController().signal)).rejects.toMatchObject({
      code: "repository_index_capacity_exceeded",
      diagnostics: {
        phase: "admission",
        resource: "process_index_bytes",
        observed: 101,
        limit: 100
      }
    } satisfies Partial<RepositoryIndexCapacityError>);
  });
});
