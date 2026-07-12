import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { FilesystemRunGraphStore } from "../../../src/studio/adapters/filesystem/run-graph-store.js";
import { NativeStudioRunDispatchQueue } from "../../../src/studio/adapters/filesystem/run-dispatch-queue.js";
import {
  NativeStudioRunTerminalJournal,
  type NativeStudioRunTerminalJournalPort
} from "../../../src/studio/adapters/filesystem/run-terminal-journal.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import type { NativeStudioRunTerminalIntent } from "../../../src/studio/adapters/native/run-terminal-intent.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import type { RunLedgerPort } from "../../../src/studio/application/runs/ports.js";
import {
  BASE_TIME,
  captureCommand,
  cleanupNativeLaunchFixtures,
  successfulResult,
  writeFixture,
  type NativeFixture
} from "./native-run-launch-test-support.js";

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

describe("native Studio concurrent terminalization", () => {
  it("refreshes the serialized lease before exposing the terminal outbox window", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const graphStore = new FilesystemRunGraphStore({
      root: path.join(fixture.root, "terminal-lease-race-graphs")
    });
    const durableJournal = new NativeStudioRunTerminalJournal({
      queueRoot: fixture.queueRoot
    });
    const terminalMayPersist = deferred();
    const terminalWriteEntered = deferred();
    const runtimeMayTerminalize = deferred();
    const runtimeReachedTerminal = deferred();
    const scheduled: Array<() => void> = [];
    const ownerErrors: unknown[] = [];
    let currentNow = BASE_TIME;
    const journal: NativeStudioRunTerminalJournalPort = {
      write: async (intent) => {
        terminalWriteEntered.resolve();
        await terminalMayPersist.promise;
        await durableJournal.write(intent);
      },
      read: async (runId) => await durableJournal.read(runId)
    };
    const owner = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      graphStore,
      terminalJournal: journal,
      platform: nativeLunaPlatformRegistrations,
      ownerId: "terminal-lease-owner",
      now: () => currentNow,
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => scheduled.push(task),
      onBackgroundError: (cause) => ownerErrors.push(cause),
      runWorkflow: async (input) => await successfulResult(input, {
        afterSuccessProjection: async () => {
          runtimeReachedTerminal.resolve();
          await runtimeMayTerminalize.promise;
        }
      })
    });
    let observer: NativeStudioRunDispatcher | undefined;
    try {
      await owner.initialize();
      const receipt = await owner.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      await runtimeReachedTerminal.promise;
      const beforeTerminal = await store.ledger.get(receipt.run_id);
      const previousHeartbeat = Date.parse(beforeTerminal?.heartbeat_at ?? "");
      expect(Number.isFinite(previousHeartbeat)).toBe(true);
      currentNow = previousHeartbeat + 120_000;
      runtimeMayTerminalize.resolve();
      await terminalWriteEntered.promise;

      const refreshed = await store.ledger.get(receipt.run_id);
      expect(Date.parse(refreshed?.heartbeat_at ?? "")).toBeGreaterThanOrEqual(
        currentNow
      );
      observer = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        ledger: store.ledger,
        graphStore,
        platform: nativeLunaPlatformRegistrations,
        ownerId: "terminal-lease-observer",
        now: () => currentNow,
        heartbeatIntervalMs: 1_000,
        orphanThresholdMs: 3_000,
        onBackgroundError: () => undefined,
        runWorkflow: async () => {
          throw new Error("A healthy terminalizing owner must not be stolen");
        }
      });
      await observer.initialize();
      await expect(store.ledger.get(receipt.run_id)).resolves.toMatchObject({
        run_status: "running",
        owner_id: "terminal-lease-owner"
      });

      terminalMayPersist.resolve();
      await vi.waitFor(async () => {
        expect(await store.ledger.get(receipt.run_id)).toMatchObject({
          run_status: "succeeded",
          completeness: "complete"
        });
      });
      expect(ownerErrors).toEqual([]);
    } finally {
      runtimeMayTerminalize.resolve();
      terminalMayPersist.resolve();
      await Promise.allSettled([
        owner.close(),
        observer?.close() ?? Promise.resolve()
      ]);
      store.close();
    }
  });

  it("does not accept or delete a success intent after another Studio terminalizes the expired lease", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const graphStore = new FilesystemRunGraphStore({
      root: path.join(fixture.root, "terminal-conflict-race-graphs")
    });
    const durableJournal = new NativeStudioRunTerminalJournal({
      queueRoot: fixture.queueRoot
    });
    const terminalMayPersist = deferred();
    const terminalWriteEntered = deferred();
    const runtimeMayTerminalize = deferred();
    const runtimeReachedTerminal = deferred();
    const scheduled: Array<() => void> = [];
    const ownerErrors: unknown[] = [];
    let capturedIntent: NativeStudioRunTerminalIntent | undefined;
    let currentNow = BASE_TIME;
    const journal: NativeStudioRunTerminalJournalPort = {
      write: async (intent) => {
        capturedIntent = intent;
        terminalWriteEntered.resolve();
        await terminalMayPersist.promise;
        await durableJournal.write(intent);
      },
      read: async (runId) => await durableJournal.read(runId)
    };
    const owner = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      graphStore,
      terminalJournal: journal,
      platform: nativeLunaPlatformRegistrations,
      ownerId: "expired-terminal-owner",
      now: () => currentNow,
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => scheduled.push(task),
      onBackgroundError: (cause) => ownerErrors.push(cause),
      runWorkflow: async (input) => await successfulResult(input, {
        afterSuccessProjection: async () => {
          runtimeReachedTerminal.resolve();
          await runtimeMayTerminalize.promise;
        }
      })
    });
    const observers: NativeStudioRunDispatcher[] = [];
    try {
      await owner.initialize();
      const receipt = await owner.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      await runtimeReachedTerminal.promise;
      const beforeTerminal = await store.ledger.get(receipt.run_id);
      currentNow = Date.parse(beforeTerminal?.heartbeat_at ?? "") + 120_000;
      runtimeMayTerminalize.resolve();
      await terminalWriteEntered.promise;
      currentNow += 120_000;

      const orphanReaper = concurrentObserver({
        fixture,
        ledger: store.ledger,
        graphStore,
        now: () => currentNow,
        ownerId: "orphan-reaper"
      });
      observers.push(orphanReaper);
      await orphanReaper.initialize();
      await expect(store.ledger.get(receipt.run_id)).resolves.toMatchObject({
        run_status: "outcome_unknown",
        completeness: "partial",
        failure: { code: "studio_runtime_replay_not_authorized" }
      });

      // A second process observes the authoritative uncertain terminal while
      // the conflicting success outbox write is still blocked. No success or
      // failure proof journal is required to discard this terminal job.
      const terminalCleaner = concurrentObserver({
        fixture,
        ledger: store.ledger,
        graphStore,
        now: () => currentNow,
        ownerId: "terminal-cleaner"
      });
      observers.push(terminalCleaner);
      await terminalCleaner.initialize();
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      await queue.initialize();
      await expect(queue.inspect(receipt.run_id)).resolves.toBe("missing");

      terminalMayPersist.resolve();
      await vi.waitFor(() => expect(ownerErrors.length).toBeGreaterThan(0));
      await expect(store.ledger.get(receipt.run_id)).resolves.toMatchObject({
        run_status: "outcome_unknown",
        failure: { code: "studio_runtime_replay_not_authorized" }
      });
      expect(capturedIntent).toBeDefined();
      await expect(queue.inspect(receipt.run_id)).resolves.toBe("missing");
      await expect(durableJournal.read(receipt.run_id)).resolves.toBeUndefined();
    } finally {
      runtimeMayTerminalize.resolve();
      terminalMayPersist.resolve();
      await Promise.allSettled([
        owner.close(),
        ...observers.map(async (observer) => await observer.close())
      ]);
      store.close();
    }
  });
});

function concurrentObserver(input: {
  readonly fixture: NativeFixture;
  readonly ledger: RunLedgerPort;
  readonly graphStore: FilesystemRunGraphStore;
  readonly now: () => number;
  readonly ownerId: string;
}): NativeStudioRunDispatcher {
  return new NativeStudioRunDispatcher({
    projectRoot: input.fixture.projectRoot,
    configRoot: input.fixture.configRoot,
    queueRoot: input.fixture.queueRoot,
    ledger: input.ledger,
    graphStore: input.graphStore,
    platform: nativeLunaPlatformRegistrations,
    ownerId: input.ownerId,
    now: input.now,
    heartbeatIntervalMs: 1_000,
    orphanThresholdMs: 3_000,
    onBackgroundError: () => undefined,
    runWorkflow: async () => {
      throw new Error("A concurrent Studio must not re-execute a leased run");
    }
  });
}
