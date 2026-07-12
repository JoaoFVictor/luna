import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { NativeStudioRunRecoveryJournal } from "../../../src/studio/adapters/filesystem/run-recovery-journal.js";
import { createNativeStudioRunRecoveryIntent } from "../../../src/studio/adapters/native/run-recovery-intent.js";
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

describe("native Studio stale recovery claims", () => {
  it("does not steal a run whose original owner heartbeats after the stale scan", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const ownerTasks: Array<() => void> = [];
    const ownerErrors: unknown[] = [];
    let releaseRuntime!: () => void;
    const runtimeMayFinish = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const owner = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      graphRoot: path.join(fixture.root, "recovery-race-graphs"),
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "recovery-race-owner",
      heartbeatIntervalMs: 60_000,
      orphanThresholdMs: 180_000,
      schedule: (task) => ownerTasks.push(task),
      onBackgroundError: (cause) => ownerErrors.push(cause),
      runWorkflow: async (input) => await successfulResult(input, {
        afterStart: async () => await runtimeMayFinish
      })
    });
    let observer: NativeStudioRunDispatcher | undefined;

    try {
      await owner.initialize();
      const receipt = await owner.dispatch(command);
      ownerTasks.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          dispatch_status: "started",
          run_status: "running",
          owner_id: "recovery-race-owner",
          active_node_ids: ["analyze"]
        });
      });

      const beforeScan = await store.ledger.get(receipt.run_id);
      if (
        beforeScan?.heartbeat_at === undefined ||
        beforeScan.owner_id === undefined
      ) {
        throw new Error("Expected an owned started run before recovery scan");
      }
      const observerNow = Date.parse(beforeScan.heartbeat_at) + 120_000;
      const recoveryJournal = new NativeStudioRunRecoveryJournal({
        queueRoot: fixture.queueRoot
      });
      await recoveryJournal.write(createNativeStudioRunRecoveryIntent({
        runId: receipt.run_id,
        executionSnapshotHash: command.snapshot.execution_snapshot_hash,
        reason: "success_barrier_recovery_required"
      }));
      const recoveryTasks: Array<() => void> = [];
      const observerErrors: unknown[] = [];
      let observerExecutions = 0;
      observer = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        graphRoot: path.join(fixture.root, "recovery-race-graphs"),
        ledger: store.ledger,
        platform: nativeLunaPlatformRegistrations,
        now: () => observerNow,
        ownerId: "recovery-race-observer",
        heartbeatIntervalMs: 1_000,
        orphanThresholdMs: 3_000,
        schedule: (task) => recoveryTasks.push(task),
        onBackgroundError: (cause) => observerErrors.push(cause),
        runWorkflow: async (input) => {
          observerExecutions += 1;
          return await successfulResult(input);
        }
      });
      await observer.initialize();
      expect(recoveryTasks).toHaveLength(1);

      const current = await store.ledger.get(receipt.run_id);
      if (current?.owner_id === undefined) {
        throw new Error("Expected the original recovery-race owner");
      }
      await store.ledger.appendTransition({
        run_id: receipt.run_id,
        transition_id: "original-owner-woke-before-recovery-claim",
        event_id: "event-original-owner-woke-before-recovery-claim",
        expected_revision: current.record_revision,
        occurred_at: new Date(observerNow).toISOString(),
        transition: {
          kind: "heartbeat",
          owner_id: current.owner_id
        }
      });

      recoveryTasks.splice(0).forEach((task) => task());
      await vi.waitFor(() => expect(observerErrors).toHaveLength(1));
      expect(observerErrors[0]).toMatchObject({
        code: "studio_run_dispatch_failed"
      });
      expect(observerExecutions).toBe(0);
      expect(await store.ledger.get(receipt.run_id)).toMatchObject({
        run_status: "running",
        owner_id: "recovery-race-owner",
        heartbeat_at: new Date(observerNow).toISOString()
      });

      releaseRuntime();
      await vi.waitFor(async () => {
        if (ownerErrors[0] !== undefined) {
          throw ownerErrors[0];
        }
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          run_status: "succeeded",
          owner_id: "recovery-race-owner"
        });
      });
      expect(ownerErrors).toEqual([]);
    } finally {
      releaseRuntime();
      await Promise.allSettled([
        owner.close(),
        ...(observer === undefined ? [] : [observer.close()])
      ]);
      store.close();
    }
  });
});
