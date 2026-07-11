import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { NativeStudioRunDispatchQueue } from "../../../src/studio/adapters/filesystem/run-dispatch-queue.js";
import { NativeStudioRunTerminalJournal } from "../../../src/studio/adapters/filesystem/run-terminal-journal.js";
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

describe("native Studio terminal dispatch adoption", () => {
  it("adopts an exact succeeded run after queue cleanup without scheduling it again", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    let runtimeExecutions = 0;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "terminal-adoption-owner",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => {
        runtimeExecutions += 1;
        return await successfulResult(input);
      }
    });
    try {
      await dispatcher.initialize();
      const first = await dispatcher.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      await vi.waitFor(async () => {
        await expect(store.ledger.get(first.run_id)).resolves.toMatchObject({
          dispatch_status: "started",
          run_status: "succeeded",
          accepted_plan_id: command.planId
        });
        await expect(queue.inspect(first.run_id)).resolves.toBe("missing");
      });

      const completed = await store.ledger.get(first.run_id);
      const completedRevision = completed?.record_revision;
      const retryPlanId = `rp_${"r".repeat(32)}`;
      const adopted = await dispatcher.dispatch({
        ...command,
        planId: retryPlanId
      });

      expect(adopted).toEqual({
        accepted: true,
        dispatch_status: "queued",
        run_id: first.run_id,
        plan_id: retryPlanId,
        execution_snapshot_hash: first.execution_snapshot_hash,
        accepted_at: first.accepted_at
      });
      expect(runtimeExecutions).toBe(1);
      expect(scheduled).toEqual([]);
      await expect(queue.listRunIds()).resolves.toEqual([]);
      await expect(store.ledger.get(first.run_id)).resolves.toMatchObject({
        record_revision: completedRevision,
        accepted_plan_id: command.planId,
        run_id: first.run_id,
        run_status: "succeeded"
      });
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("removes a legacy outcome-unknown job on restart without a terminal journal", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    let runtimeExecutions = 0;
    const first = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "legacy-outcome-owner",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async () => {
        runtimeExecutions += 1;
        throw new Error("A manually terminal legacy job must never execute");
      }
    });
    let runId: string | undefined;
    try {
      await first.initialize();
      const receipt = await first.dispatch(command);
      runId = receipt.run_id;
      await store.ledger.appendTransition({
        run_id: receipt.run_id,
        transition_id: "legacy-outcome-prepare",
        event_id: "event-legacy-outcome-prepare",
        expected_revision: 1,
        occurred_at: new Date(BASE_TIME + 1).toISOString(),
        transition: {
          kind: "dispatch_preparing",
          owner_id: "legacy-outcome-owner"
        }
      });
      await store.ledger.appendTransition({
        run_id: receipt.run_id,
        transition_id: "legacy-outcome-start",
        event_id: "event-legacy-outcome-start",
        expected_revision: 2,
        occurred_at: new Date(BASE_TIME + 2).toISOString(),
        transition: {
          kind: "dispatch_started",
          owner_id: "legacy-outcome-owner",
          active_node_ids: ["analyze"]
        }
      });
      await store.ledger.appendTransition({
        run_id: receipt.run_id,
        transition_id: "legacy-outcome-terminal",
        event_id: "event-legacy-outcome-terminal",
        expected_revision: 3,
        occurred_at: new Date(BASE_TIME + 3).toISOString(),
        transition: {
          kind: "runtime_status",
          owner_id: "legacy-outcome-owner",
          status: "outcome_unknown",
          active_node_ids: [],
          completeness: "partial",
          failure: {
            code: "studio_legacy_outcome_unknown",
            message: "Legacy worker retained an uncertain terminal job"
          }
        }
      });
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      await expect(queue.inspect(receipt.run_id)).resolves.toBe("present");
      const terminalJournal = new NativeStudioRunTerminalJournal({
        queueRoot: fixture.queueRoot
      });
      await expect(terminalJournal.read(receipt.run_id)).resolves.toBeUndefined();
    } finally {
      await first.close();
    }

    if (runId === undefined) {
      store.close();
      throw new Error("Expected the legacy Studio run to be accepted");
    }
    const restartTasks: Array<() => void> = [];
    const restarted = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 120_000,
      ownerId: "legacy-outcome-cleaner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => restartTasks.push(task),
      runWorkflow: async () => {
        runtimeExecutions += 1;
        throw new Error("A legacy uncertain terminal must never replay");
      }
    });
    try {
      await restarted.initialize();
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      await expect(queue.inspect(runId)).resolves.toBe("missing");
      await expect(queue.listRunIds()).resolves.toEqual([]);
      await expect(store.ledger.get(runId)).resolves.toMatchObject({
        run_status: "outcome_unknown",
        completeness: "partial",
        failure: { code: "studio_legacy_outcome_unknown" }
      });
      expect(runtimeExecutions).toBe(0);
      expect(restartTasks).toEqual([]);
    } finally {
      await restarted.close();
      store.close();
    }
  });
});
