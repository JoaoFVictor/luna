import path from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import type { StudioRunDiagnostic } from "../../../src/studio/application/runs/diagnostics.js";
import { FilesystemRunGraphStore } from "../../../src/studio/adapters/filesystem/run-graph-store.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import {
  BASE_TIME,
  captureCommand,
  cleanupNativeLaunchFixtures,
  successfulResult,
  writeFixture
} from "./native-run-launch-test-support.js";
import { faultInjection } from "./native-run-finalization-test-support.js";
import { preallocation } from "./helpers.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

describe("native Studio terminal commit recovery", () => {
  it("paginates stale owners and fails missing jobs instead of blocking after 200", async () => {
    const fixture = await writeFixture();
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const runIds = Array.from(
      { length: 201 },
      (_, index) => `missing-job-${String(index).padStart(3, "0")}`
    );
    for (const runId of runIds) {
      await store.ledger.preallocate(preallocation(runId));
      await store.ledger.appendTransition({
        run_id: runId,
        transition_id: `prepare-${runId}`,
        event_id: `event-prepare-${runId}`,
        expected_revision: 1,
        occurred_at: "2026-07-10T12:00:01.000Z",
        transition: {
          kind: "dispatch_preparing",
          owner_id: `owner-${runId}`
        }
      });
    }
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      runWorkflow: async () => {
        throw new Error("missing durable jobs must not execute")
      }
    });

    try {
      await dispatcher.initialize();
      await expect(store.ledger.get(runIds[0]!)).resolves.toMatchObject({
        dispatch_status: "rejected",
        failure: { code: "studio_dispatch_job_missing" }
      });
      await expect(store.ledger.get(runIds[200]!)).resolves.toMatchObject({
        dispatch_status: "rejected",
        failure: { code: "studio_dispatch_job_missing" }
      });
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("reaps a terminal deletion left by a crash on the next recovery sweep", async () => {
    const fixture = await writeFixture();
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const diagnostics: StudioRunDiagnostic[] = [];
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      runDiagnostics: {
        report: (diagnostic) => {
          diagnostics.push(diagnostic);
        }
      },
      runWorkflow: async (input) => await successfulResult(input)
    });
    try {
      await dispatcher.initialize();
      const jobsRoot = path.join(fixture.queueRoot, "jobs");
      const tombstone = ".deleting-run-after-rename-before-remove";
      await mkdir(path.join(jobsRoot, tombstone));

      await vi.waitFor(async () => {
        expect(await readdir(jobsRoot)).not.toContain(tombstone);
      }, { timeout: 2_500, interval: 100 });
      expect(diagnostics).toEqual([]);
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it.each([
    "before_intent",
    "after_intent",
    "after_outcome",
    "after_terminal"
  ] as const)("recovers the %s crash window without a false complete record", async (window) => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const graphStore = new FilesystemRunGraphStore({
      root: path.join(fixture.root, "terminal-recovery-graphs")
    });
    const scheduled: Array<() => void> = [];
    const backgroundErrors: unknown[] = [];
    const fault = faultInjection(window, store.ledger, graphStore);
    let runtimeExecutions = 0;
    const interrupted = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: fault.ledger,
      graphStore: fault.graphStore,
      ...(fault.terminalJournal === undefined
        ? {}
        : { terminalJournal: fault.terminalJournal }),
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: `worker-${window}`,
      schedule: (task) => scheduled.push(task),
      onBackgroundError: (cause) => backgroundErrors.push(cause),
      runWorkflow: async (input) => {
        runtimeExecutions += 1;
        return await successfulResult(input);
      }
    });

    try {
      await interrupted.initialize();
      const receipt = await interrupted.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      if (window === "before_intent") {
        await vi.waitFor(() => expect(backgroundErrors).toHaveLength(1));
      } else {
        await vi.waitFor(async () => {
          expect(await store.ledger.get(receipt.run_id)).toMatchObject({
            run_status: "succeeded",
            completeness: "complete"
          });
        });
        expect(backgroundErrors).toEqual([]);
      }
      await interrupted.close();

      const beforeRecovery = await store.ledger.get(receipt.run_id);
      if (window !== "before_intent") {
        expect(beforeRecovery).toMatchObject({
          run_status: "succeeded",
          completeness: "complete"
        });
      } else {
        expect(beforeRecovery).toMatchObject({
          run_status: "running",
          completeness: "complete"
        });
      }

      let recoveryExecutions = 0;
      const recoveryErrors: unknown[] = [];
      let recoveryNow = Math.max(
        BASE_TIME,
        Date.parse(beforeRecovery?.heartbeat_at ?? "")
      );
      const recovered = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        ledger: store.ledger,
        graphStore,
        platform: nativeLunaPlatformRegistrations,
        now: () => recoveryNow,
        ownerId: `recovery-${window}`,
        ...(window === "before_intent"
          ? { heartbeatIntervalMs: 1_000, orphanThresholdMs: 3_000 }
          : {}),
        onBackgroundError: (cause) => recoveryErrors.push(cause),
        runWorkflow: async (input) => {
          recoveryExecutions += 1;
          return await successfulResult(input);
        }
      });
      try {
        await recovered.initialize();
        if (window === "before_intent") {
          expect(await store.ledger.get(receipt.run_id)).toMatchObject({
            run_status: "running"
          });
          recoveryNow = Date.parse(
            (await store.ledger.get(receipt.run_id))?.heartbeat_at ?? ""
          ) + 120_000;
          await vi.waitFor(async () => {
            if (recoveryErrors[0] !== undefined) {
              throw recoveryErrors[0];
            }
            expect(await store.ledger.get(receipt.run_id)).toMatchObject({
              run_status: "outcome_unknown",
              completeness: "partial",
              failure: { code: "studio_runtime_replay_not_authorized" }
            });
          }, { timeout: 2_500, interval: 100 });
          const terminal = await store.ledger.get(receipt.run_id);
          expect(terminal).toMatchObject({
            run_status: "outcome_unknown",
            completeness: "partial",
            owner_id: "worker-before_intent"
          });
          await expect(graphStore.readOutcome(
            terminal?.graph_snapshot_handle ?? ""
          )).resolves.toEqual({ kind: "missing" });
        } else {
          const terminal = await store.ledger.get(receipt.run_id);
          expect(terminal).toMatchObject({
            run_status: "succeeded",
            completeness: "complete"
          });
          await expect(graphStore.readOutcome(
            terminal?.graph_snapshot_handle ?? ""
          )).resolves.toMatchObject({
            kind: "available",
            value: {
              run_status: "succeeded",
              record_revision: terminal?.record_revision
            }
          });
        }
        expect(runtimeExecutions).toBe(1);
        expect(recoveryExecutions).toBe(0);
        expect(recoveryErrors).toEqual([]);
      } finally {
        await recovered.close();
      }
    } finally {
      await interrupted.close();
      store.close();
    }
  });
});
