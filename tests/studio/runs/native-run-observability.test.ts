import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import type { RunLedgerPort } from "../../../src/studio/application/runs/ports.js";
import { RunGraphService } from "../../../src/studio/application/runs/graph-service.js";
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

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

describe("native Studio run observability", () => {
  it("never steals a healthy run owned and heartbeating in another Studio", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const graphStore = new FilesystemRunGraphStore({
      root: path.join(fixture.root, "multi-studio-graphs")
    });
    const scheduled: Array<() => void> = [];
    let releaseRuntime!: () => void;
    const runtimeMayFinish = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const owner = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      graphStore,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "healthy-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => await successfulResult(input, {
        afterStart: async () => await runtimeMayFinish
      })
    });
    let secondRuntimeExecutions = 0;
    const observer = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      graphStore,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "healthy-observer",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      runWorkflow: async (input) => {
        secondRuntimeExecutions += 1;
        return await successfulResult(input);
      }
    });
    try {
      await owner.initialize();
      const receipt = await owner.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          dispatch_status: "started",
          run_status: "running",
          owner_id: "healthy-owner",
          active_node_ids: ["analyze"]
        });
      });
      const beforeHeartbeat = await store.ledger.get(receipt.run_id);
      const events = await store.events.list({
        run_id: receipt.run_id,
        direction: "asc",
        event_types: [],
        limit: 50
      });
      expect(events.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event_type: "run.node.started",
          data: expect.objectContaining({
            active_node_ids: ["analyze"],
            node_event: expect.objectContaining({
              type: "node.started",
              node_id: "analyze",
              attempt: 1
            })
          })
        })
      ]));
      await expect(new RunGraphService({
        ledger: store.ledger,
        store: graphStore
      }).get(receipt.run_id)).resolves.toMatchObject({
        availability: "available",
        overlay: {
          observation: "observed",
          source: "live",
          nodes: [{ node_id: "analyze", status: "running" }]
        }
      });
      await vi.waitFor(async () => {
        const current = await store.ledger.get(receipt.run_id);
        expect(current?.record_revision).toBeGreaterThan(
          beforeHeartbeat?.record_revision ?? 0
        );
      }, { timeout: 2_500, interval: 100 });

      await observer.initialize();
      expect(await store.ledger.get(receipt.run_id)).toMatchObject({
        run_status: "running",
        owner_id: "healthy-owner",
        active_node_ids: ["analyze"]
      });
      expect(secondRuntimeExecutions).toBe(0);

      releaseRuntime();
      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          run_status: "succeeded",
          completeness: "complete"
        });
      });
      expect(secondRuntimeExecutions).toBe(0);
    } finally {
      releaseRuntime();
      await Promise.allSettled([owner.close(), observer.close()]);
      store.close();
    }
  });

  it("degrades completeness without retrying when post-node projection fails", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const graphStore = new FilesystemRunGraphStore({
      root: path.join(fixture.root, "projection-failure-graphs")
    });
    const scheduled: Array<() => void> = [];
    let projectionFaulted = false;
    let releaseRuntime!: () => void;
    const runtimeMayFinish = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const ledger: RunLedgerPort = {
      preallocate: async (input) => await store.ledger.preallocate(input),
      appendTransition: async (input) => {
        if (
          input.transition.kind === "node_lifecycle" &&
          input.transition.event.type === "node.succeeded" &&
          !projectionFaulted
        ) {
          projectionFaulted = true;
          throw new Error("simulated post-effect projection failure");
        }
        return await store.ledger.appendTransition(input);
      },
      get: async (runId) => await store.ledger.get(runId),
      listOrphanCandidates: async (input) =>
        await store.ledger.listOrphanCandidates(input)
    };
    let executions = 0;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger,
      graphStore,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "projection-failure-owner",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => {
        executions += 1;
        return await successfulResult(input, {
          duplicateStartObservation: true,
          afterSuccessProjection: async () => await runtimeMayFinish
        });
      }
    });
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          run_status: "running",
          lifecycle_projection: "degraded"
        });
      });
      await expect(new RunGraphService({
        ledger: store.ledger,
        store: graphStore
      }).get(receipt.run_id)).resolves.toMatchObject({
        availability: "available",
        overlay: {
          observation: "unobservable",
          reason: "live_projection_invalid"
        }
      });
      releaseRuntime();
      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          run_status: "succeeded",
          lifecycle_projection: "degraded",
          completeness: "partial"
        });
      });
      expect(executions).toBe(1);
      const events = await store.events.list({
        run_id: receipt.run_id,
        direction: "asc",
        event_types: [],
        limit: 50
      });
      expect(events.items.map((event) => event.event_type)).toContain(
        "run.node.started"
      );
      expect(events.items.filter(
        (event) => event.event_type === "run.node.started"
      )).toHaveLength(1);
      expect(events.items.map((event) => event.event_type)).not.toContain(
        "run.node.succeeded"
      );
    } finally {
      releaseRuntime();
      await dispatcher.close();
      store.close();
    }
  });
});
