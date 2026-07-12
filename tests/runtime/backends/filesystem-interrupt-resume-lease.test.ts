import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StaleLockRecovery } from "../../../src/core/workflow/stale-lock-recovery.js";
import { createFilesystemInterruptStore } from "../../../src/runtime/backends/filesystem/interrupts.js";

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("filesystem interrupt resume lease", () => {
  it("serializes separate stores through their shared filesystem root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-resume-lease-"));
    const firstStore = createFilesystemInterruptStore({ root });
    const secondStore = createFilesystemInterruptStore({ root });
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const contentionObserved = deferred();
    let activeOperations = 0;
    let maxActiveOperations = 0;
    let secondEntered = false;
    const lockPrototype = StaleLockRecovery.prototype;
    const originalRecovery = lockPrototype.tryRecover;
    const recoverySpy = vi
      .spyOn(lockPrototype, "tryRecover")
      .mockImplementation(async function (
        this: StaleLockRecovery,
        resource,
        lockDir
      ) {
        contentionObserved.resolve();
        await originalRecovery.call(this, resource, lockDir);
      });

    try {
      const firstLease = firstStore.withResumeLease("interrupt-1", async () => {
        activeOperations += 1;
        maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
        firstEntered.resolve();
        await releaseFirst.promise;
        activeOperations -= 1;
      });
      await firstEntered.promise;

      const secondLease = secondStore.withResumeLease("interrupt-1", async () => {
        secondEntered = true;
        activeOperations += 1;
        maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
        activeOperations -= 1;
      });
      await contentionObserved.promise;

      try {
        expect(secondEntered).toBe(false);
        expect(activeOperations).toBe(1);
      } finally {
        releaseFirst.resolve();
      }

      await Promise.all([firstLease, secondLease]);
      expect(secondEntered).toBe(true);
      expect(activeOperations).toBe(0);
      expect(maxActiveOperations).toBe(1);
    } finally {
      releaseFirst.resolve();
      recoverySpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
