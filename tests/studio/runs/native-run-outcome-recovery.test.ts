import path from "node:path";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { NativeStudioRunDispatchQueue } from "../../../src/studio/adapters/filesystem/run-dispatch-queue.js";
import {
  NativeStudioRunTerminalJournal,
  type NativeStudioRunTerminalJournalPort
} from "../../../src/studio/adapters/filesystem/run-terminal-journal.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import {
  BASE_TIME,
  captureCommand,
  cleanupNativeLaunchFixtures,
  policyBearingAgentAndPatternSource,
  successfulResult,
  writeFixture
} from "./native-run-launch-test-support.js";
import { createInterruptedTerminalRun } from "./native-run-finalization-test-support.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});
describe("native Studio terminal outcome recovery", () => {
  it("never replays write effects when the success barrier has no durable intent", async () => {
    const fixture = await writeFixture();
    await writeFile(
      fixture.workflowPath,
      policyBearingAgentAndPatternSource(fixture)
    );
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    const ownerErrors: unknown[] = [];
    let acceptedEffects = 0;
    const interrupted = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      terminalJournal: {
        write: async () => {
          throw new Error("terminal intent storage unavailable");
        },
        read: async () => undefined
      },
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "write-success-barrier-owner",
      schedule: (task) => scheduled.push(task),
      onBackgroundError: (cause) => ownerErrors.push(cause),
      runWorkflow: async (input) => await successfulResult(input, {
        afterSuccessProjection: async () => {
          acceptedEffects += 1;
        }
      })
    });
    try {
      await interrupted.initialize();
      const receipt = await interrupted.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(() => expect(ownerErrors).toHaveLength(1));
      const retained = await store.ledger.get(receipt.run_id);
      expect(retained).toMatchObject({
        run_status: "running",
        dispatch_status: "started"
      });
      expect(acceptedEffects).toBe(1);
      await interrupted.close();

      let recoveryExecutions = 0;
      const recoveryNow = Date.parse(retained?.heartbeat_at ?? "") + 120_000;
      const recovered = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        ledger: store.ledger,
        platform: nativeLunaPlatformRegistrations,
        now: () => recoveryNow,
        ownerId: "write-success-barrier-observer",
        heartbeatIntervalMs: 1_000,
        orphanThresholdMs: 3_000,
        onBackgroundError: () => undefined,
        runWorkflow: async (input) => {
          recoveryExecutions += 1;
          return await successfulResult(input);
        }
      });
      try {
        await recovered.initialize();
        await expect(store.ledger.get(receipt.run_id)).resolves.toMatchObject({
          run_status: "outcome_unknown",
          completeness: "partial",
          failure: { code: "studio_runtime_replay_not_authorized" }
        });
        expect(recoveryExecutions).toBe(0);
        const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
        await expect(queue.inspect(receipt.run_id)).resolves.toBe("present");
      } finally {
        await recovered.close();
      }
    } finally {
      await interrupted.close();
      store.close();
    }
  });

  it.each([
    "terminal",
    "outcome",
    "graph"
  ] as const)("marks a stale run unknown when its durable %s record is corrupt", async (recordKind) => {
    const interrupted = await createInterruptedTerminalRun(
      recordKind === "outcome" ? "after_outcome" : "after_intent"
    );
    const beforeRecovery = await interrupted.store.ledger.get(
      interrupted.runId
    );
    const handle = beforeRecovery?.graph_snapshot_handle;
    if (handle === undefined) {
      throw new Error("Expected a durable graph handle for corruption fixture");
    }
    const corruptPath = recordKind === "terminal"
      ? path.join(
          interrupted.fixture.queueRoot,
          "jobs",
          interrupted.runId,
          "terminal.json"
        )
      : path.join(
          interrupted.graphRoot,
          "snapshots",
          handle,
          recordKind === "outcome" ? "outcome.json" : "graph.json"
        );
    await writeFile(corruptPath, "{", "utf8");

    let recoveryExecutions = 0;
    const recoveryNow = Date.parse(beforeRecovery?.heartbeat_at ?? "") +
      120_000;
    const recovered = new NativeStudioRunDispatcher({
      projectRoot: interrupted.fixture.projectRoot,
      configRoot: interrupted.fixture.configRoot,
      queueRoot: interrupted.fixture.queueRoot,
      ledger: interrupted.store.ledger,
      graphStore: interrupted.graphStore,
      platform: nativeLunaPlatformRegistrations,
      now: () => recoveryNow,
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      onBackgroundError: () => undefined,
      runWorkflow: async (input) => {
        recoveryExecutions += 1;
        return await successfulResult(input);
      }
    });
    try {
      await recovered.initialize();
      await expect(interrupted.store.ledger.get(interrupted.runId)).resolves
        .toMatchObject({
          run_status: "outcome_unknown",
          completeness: "partial",
          failure: { code: "studio_runtime_terminal_recovery_invalid" }
        });
      expect(recoveryExecutions).toBe(0);
    } finally {
      await recovered.close();
      interrupted.store.close();
    }
  });

  it("retries a transient terminal journal read without failing or re-executing the run", async () => {
    const interrupted = await createInterruptedTerminalRun("after_intent");
    const interruptedRecord = await interrupted.store.ledger.get(
      interrupted.runId
    );
    const recoveryNow = Date.parse(interruptedRecord?.heartbeat_at ?? "") +
      120_000;
    const durableJournal = new NativeStudioRunTerminalJournal({
      queueRoot: interrupted.fixture.queueRoot
    });
    let unavailable = true;
    const journal: NativeStudioRunTerminalJournalPort = {
      write: async (intent) => await durableJournal.write(intent),
      read: async (runId) => {
        if (unavailable) {
          throw Object.assign(new Error("simulated terminal journal EIO"), {
            code: "EIO"
          });
        }
        return await durableJournal.read(runId);
      }
    };
    let recoveryExecutions = 0;
    const options = {
      projectRoot: interrupted.fixture.projectRoot,
      configRoot: interrupted.fixture.configRoot,
      queueRoot: interrupted.fixture.queueRoot,
      ledger: interrupted.store.ledger,
      graphStore: interrupted.graphStore,
      terminalJournal: journal,
      platform: nativeLunaPlatformRegistrations,
      now: () => recoveryNow,
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      onBackgroundError: () => undefined,
      runWorkflow: async (input: Parameters<typeof successfulResult>[0]) => {
        recoveryExecutions += 1;
        return await successfulResult(input);
      }
    } as const;
    const unavailableRecovery = new NativeStudioRunDispatcher(options);
    try {
      await unavailableRecovery.initialize();
      await expect(interrupted.store.ledger.get(interrupted.runId)).resolves
        .toMatchObject({ run_status: "running" });
    } finally {
      await unavailableRecovery.close();
    }

    unavailable = false;
    const availableRecovery = new NativeStudioRunDispatcher(options);
    try {
      await availableRecovery.initialize();
      await expect(interrupted.store.ledger.get(interrupted.runId)).resolves
        .toMatchObject({
          run_status: "succeeded",
          completeness: "complete"
        });
      expect(recoveryExecutions).toBe(0);
    } finally {
      await availableRecovery.close();
      interrupted.store.close();
    }
  });
});
