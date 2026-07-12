import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import type { RunLedgerPort } from "../../../src/studio/application/runs/ports.js";
import type { StudioRunDiagnostic } from "../../../src/studio/application/runs/diagnostics.js";
import { FilesystemRunGraphStore } from "../../../src/studio/adapters/filesystem/run-graph-store.js";
import { NativeStudioRunDispatchQueue } from "../../../src/studio/adapters/filesystem/run-dispatch-queue.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import {
  BASE_TIME,
  captureCommand,
  cleanupNativeLaunchFixtures,
  successfulResult,
  writeFixture
} from "./native-run-launch-test-support.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

describe("native Studio run lease safety", () => {
  it("keeps a healthy preparing owner leased before the compiled barrier", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const graphStore = new FilesystemRunGraphStore({
      root: path.join(fixture.root, "preparing-owner-graphs")
    });
    const scheduled: Array<() => void> = [];
    const backgroundErrors: unknown[] = [];
    const heartbeatErrors: unknown[] = [];
    let heartbeatAttempts = 0;
    const ownerLedger: RunLedgerPort = {
      preallocate: async (input) => await store.ledger.preallocate(input),
      appendTransition: async (input) => {
        if (input.transition.kind === "heartbeat") {
          heartbeatAttempts += 1;
        }
        try {
          return await store.ledger.appendTransition(input);
        } catch (cause) {
          if (input.transition.kind === "heartbeat") {
            heartbeatErrors.push(cause);
          }
          throw cause;
        }
      },
      get: async (runId) => await store.ledger.get(runId),
      listOrphanCandidates: async (input) =>
        await store.ledger.listOrphanCandidates(input)
    };
    let currentNow = BASE_TIME;
    let releasePreparation!: () => void;
    const preparationMayFinish = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const owner = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: ownerLedger,
      graphStore,
      platform: nativeLunaPlatformRegistrations,
      now: () => currentNow,
      ownerId: "preparing-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => scheduled.push(task),
      onBackgroundError: (cause) => backgroundErrors.push(cause),
      runWorkflow: async (input) => await successfulResult(input, {
        beforeCompiledBarrier: async () => await preparationMayFinish
      })
    });
    let observerExecutions = 0;
    const observer = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      graphStore,
      platform: nativeLunaPlatformRegistrations,
      now: () => currentNow,
      ownerId: "preparing-observer",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      runWorkflow: async (input) => {
        observerExecutions += 1;
        return await successfulResult(input);
      }
    });
    try {
      await owner.initialize();
      const receipt = await owner.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          dispatch_status: "preparing",
          owner_id: "preparing-owner"
        });
      });

      const advancingClock = setInterval(() => {
        currentNow += 500;
      }, 100);
      try {
        await vi.waitFor(async () => {
          if (backgroundErrors[0] !== undefined) {
            throw backgroundErrors[0];
          }
          if (heartbeatErrors[0] !== undefined) {
            throw heartbeatErrors[0];
          }
          const current = await store.ledger.get(receipt.run_id);
          expect(Date.parse(current?.heartbeat_at ?? "")).toBeGreaterThanOrEqual(
            BASE_TIME + 3_000
          );
        }, { timeout: 2_500, interval: 100 });
      } finally {
        clearInterval(advancingClock);
      }
      expect(heartbeatAttempts).toBeGreaterThan(0);

      await observer.initialize();
      expect(await store.ledger.get(receipt.run_id)).toMatchObject({
        dispatch_status: "preparing",
        owner_id: "preparing-owner"
      });
      expect(observerExecutions).toBe(0);

      releasePreparation();
      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          run_status: "succeeded",
          completeness: "complete"
        });
      });
      expect(observerExecutions).toBe(0);
    } finally {
      releasePreparation();
      await Promise.allSettled([owner.close(), observer.close()]);
      store.close();
    }
  });

  it("aborts a poisoned owner and removes its terminal recovery job", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    let heartbeatFailed = false;
    const heartbeatFailure = new Error("simulated heartbeat persistence failure");
    const ledger: RunLedgerPort = {
      preallocate: async (input) => await store.ledger.preallocate(input),
      appendTransition: async (input) => {
        if (input.transition.kind === "heartbeat" && !heartbeatFailed) {
          heartbeatFailed = true;
          throw heartbeatFailure;
        }
        return await store.ledger.appendTransition(input);
      },
      get: async (runId) => await store.ledger.get(runId),
      listOrphanCandidates: async (input) =>
        await store.ledger.listOrphanCandidates(input)
    };
    const backgroundErrors: unknown[] = [];
    const diagnostics: StudioRunDiagnostic[] = [];
    let runtimeSignal: AbortSignal | undefined;
    let workAfterLeaseLoss = 0;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger,
      platform: nativeLunaPlatformRegistrations,
      ownerId: "poisoned-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      runDiagnostics: {
        report: (diagnostic) => {
          diagnostics.push(diagnostic);
        }
      },
      onBackgroundError: (cause) => backgroundErrors.push(cause),
      runWorkflow: async (input) => {
        runtimeSignal = input.signal;
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), {
            once: true
          });
        });
        input.signal?.throwIfAborted();
        workAfterLeaseLoss += 1;
        return await successfulResult(input);
      }
    });
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          dispatch_status: "rejected"
        });
      }, { timeout: 2_500, interval: 100 });
      expect(heartbeatFailed).toBe(true);
      expect(runtimeSignal?.aborted).toBe(true);
      expect(workAfterLeaseLoss).toBe(0);
      expect(backgroundErrors).toContain(heartbeatFailure);
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "dispatch_heartbeat_failed",
          component: "dispatcher",
          run_id: receipt.run_id
        })
      ]));
      expect(JSON.stringify(diagnostics)).not.toContain(
        "simulated heartbeat persistence failure"
      );

      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      await queue.initialize();
      await vi.waitFor(async () => {
        await expect(queue.listRunIds()).resolves.toEqual([]);
      });
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("records an explicit unknown outcome when a heartbeat is lost during an effect", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    let heartbeatFailed = false;
    const heartbeatFailure = new Error("simulated in-flight lease loss");
    const ledger: RunLedgerPort = {
      preallocate: async (input) => await store.ledger.preallocate(input),
      appendTransition: async (input) => {
        if (
          input.transition.kind === "heartbeat" &&
          !heartbeatFailed &&
          (await store.ledger.get(input.run_id))?.dispatch_status === "started"
        ) {
          heartbeatFailed = true;
          throw heartbeatFailure;
        }
        return await store.ledger.appendTransition(input);
      },
      get: async (runId) => await store.ledger.get(runId),
      listOrphanCandidates: async (input) =>
        await store.ledger.listOrphanCandidates(input)
    };
    let acceptedEffects = 0;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger,
      platform: nativeLunaPlatformRegistrations,
      ownerId: "in-flight-effect-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      onBackgroundError: () => undefined,
      runWorkflow: async (input) => await successfulResult(input, {
        afterStart: async () => {
          await new Promise<void>((resolve) => {
            input.signal?.addEventListener("abort", () => resolve(), {
              once: true
            });
          });
          acceptedEffects += 1;
          input.signal?.throwIfAborted();
        }
      })
    });
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          run_status: "outcome_unknown",
          completeness: "partial",
          failure: { code: "studio_runtime_control_lost" }
        });
      }, { timeout: 3_500, interval: 100 });
      expect(heartbeatFailed).toBe(true);
      expect(acceptedEffects).toBe(1);
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      await expect(queue.inspect(receipt.run_id)).resolves.toBe("missing");
    } finally {
      await dispatcher.close();
      store.close();
    }
  });
});
