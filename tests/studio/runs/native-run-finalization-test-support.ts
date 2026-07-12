import path from "node:path";
import { expect, vi } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import type { RunLedgerPort } from "../../../src/studio/application/runs/ports.js";
import type { RunGraphSnapshotStorePort } from "../../../src/studio/application/runs/graph-snapshot.js";
import { FilesystemRunGraphStore } from "../../../src/studio/adapters/filesystem/run-graph-store.js";
import {
  NativeStudioRunTerminalJournal,
  type NativeStudioRunTerminalJournalPort
} from "../../../src/studio/adapters/filesystem/run-terminal-journal.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import {
  BASE_TIME,
  captureCommand,
  successfulResult,
  writeFixture
} from "./native-run-launch-test-support.js";

export type FaultWindow =
  | "before_intent"
  | "after_intent"
  | "after_outcome"
  | "after_terminal";

export async function createInterruptedTerminalRun(
  window: "after_intent" | "after_outcome"
) {
  const fixture = await writeFixture();
  const { command } = await captureCommand(fixture);
  const store = await createSqliteRunStore({ filePath: fixture.databasePath });
  const graphRoot = path.join(
    fixture.root,
    `corrupt-terminal-${window}-graphs`
  );
  const graphStore = new FilesystemRunGraphStore({ root: graphRoot });
  const fault = faultInjection(window, store.ledger, graphStore, true);
  const scheduled: Array<() => void> = [];
  const dispatcher = new NativeStudioRunDispatcher({
    projectRoot: fixture.projectRoot,
    configRoot: fixture.configRoot,
    queueRoot: fixture.queueRoot,
    ledger: fault.ledger,
    graphStore: fault.graphStore,
    platform: nativeLunaPlatformRegistrations,
    now: () => BASE_TIME,
    ownerId: `interrupted-${window}`,
    schedule: (task) => scheduled.push(task),
    onBackgroundError: () => undefined,
    runWorkflow: async (input) => await successfulResult(input)
  });
  try {
    await dispatcher.initialize();
    const receipt = await dispatcher.dispatch(command);
    scheduled.splice(0).forEach((task) => task());
    const journal = new NativeStudioRunTerminalJournal({
      queueRoot: fixture.queueRoot
    });
    await vi.waitFor(async () => {
      await expect(journal.read(receipt.run_id)).resolves.toBeDefined();
    });
    return {
      fixture,
      store,
      graphRoot,
      graphStore,
      runId: receipt.run_id
    };
  } catch (cause) {
    store.close();
    throw cause;
  } finally {
    await dispatcher.close();
  }
}

export function faultInjection(
  window: FaultWindow,
  durableLedger: RunLedgerPort,
  durableGraphStore: RunGraphSnapshotStorePort,
  persistent = false
): {
  readonly ledger: RunLedgerPort;
  readonly graphStore: RunGraphSnapshotStorePort;
  readonly terminalJournal?: NativeStudioRunTerminalJournalPort;
} {
  let faulted = false;
  const terminalJournal: NativeStudioRunTerminalJournalPort | undefined =
    window === "before_intent"
      ? {
          write: async () => {
            throw new Error("simulated crash before terminal intent");
          },
          read: async () => undefined
        }
      : undefined;
  const graphStore: RunGraphSnapshotStorePort = {
    initialize: async () => await durableGraphStore.initialize(),
    writeGraph: async (snapshot) => await durableGraphStore.writeGraph(snapshot),
    writeOutcome: async (outcome) => {
      if (window === "after_intent" && (!faulted || persistent)) {
        faulted = true;
        throw new Error("simulated crash after terminal intent");
      }
      await durableGraphStore.writeOutcome(outcome);
    },
    readGraph: async (handle) => await durableGraphStore.readGraph(handle),
    readOutcome: async (handle) => await durableGraphStore.readOutcome(handle)
  };
  const ledger: RunLedgerPort = {
    preallocate: async (input) => await durableLedger.preallocate(input),
    appendTransition: async (input) => {
      const terminal = input.transition.kind === "runtime_status" &&
        input.transition.status === "succeeded";
      if (
        window === "after_outcome" &&
        terminal &&
        (!faulted || persistent)
      ) {
        faulted = true;
        throw new Error("simulated crash after durable outcome");
      }
      const result = await durableLedger.appendTransition(input);
      if (
        window === "after_terminal" &&
        terminal &&
        (!faulted || persistent)
      ) {
        faulted = true;
        throw new Error("simulated crash after terminal transition");
      }
      return result;
    },
    get: async (runId) => await durableLedger.get(runId),
    listOrphanCandidates: async (input) =>
      await durableLedger.listOrphanCandidates(input)
  };
  return {
    ledger,
    graphStore,
    ...(terminalJournal === undefined ? {} : { terminalJournal })
  };
}
