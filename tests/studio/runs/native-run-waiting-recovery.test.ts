import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeError } from "../../../src/core/runtime/errors.js";
import type { InterruptRecord } from "../../../src/core/runtime/interrupts/contracts.js";
import type { WorkflowRunResult } from "../../../src/core/workflow/execution-contracts.js";
import type { LunaRuntimeState } from "../../../src/core/runtime/state.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { FilesystemRunGraphStore } from "../../../src/studio/adapters/filesystem/run-graph-store.js";
import { NativeStudioRunRecoveryJournal } from "../../../src/studio/adapters/filesystem/run-recovery-journal.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import type { RunGraphSnapshotStorePort } from "../../../src/studio/application/runs/graph-snapshot.js";
import {
  BASE_TIME,
  captureCommand,
  cleanupNativeLaunchFixtures,
  waitForRun,
  writeFixture
} from "./native-run-launch-test-support.js";
import {
  interruptPort,
  interruptRecord,
  waitingResult
} from "./native-run-resume-test-support.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

type CrashedWaitingRun = Awaited<ReturnType<typeof createCrashedWaitingRun>>;

async function createCrashedWaitingRun() {
  const fixture = await writeFixture();
  const { command } = await captureCommand(fixture);
  const store = await createSqliteRunStore({ filePath: fixture.databasePath });
  const graphRoot = path.join(fixture.root, "waiting-recovery-graphs");
  const interrupts = new Map<string, InterruptRecord>();
  const durableInterrupts = interruptPort(interrupts);
  const tasks: Array<() => void> = [];
  let waitingState: LunaRuntimeState | undefined;
  const crashed = new NativeStudioRunDispatcher({
    projectRoot: fixture.projectRoot,
    configRoot: fixture.configRoot,
    queueRoot: fixture.queueRoot,
    graphRoot,
    ledger: store.ledger,
    platform: nativeLunaPlatformRegistrations,
    now: () => BASE_TIME + 20_000,
    ownerId: "initial-wait-crashed-owner",
    heartbeatIntervalMs: 1_000,
    orphanThresholdMs: 3_000,
    schedule: (task) => tasks.push(task),
    runWorkflow: async (input) => {
      const result = await waitingResult(input);
      waitingState = result.state;
      return result;
    },
    resume: {
      interrupts: durableInterrupts,
      journal: store.resumes,
      platform: nativeLunaPlatformRegistrations
    }
  });
  await crashed.initialize();
  const launch = await crashed.dispatch(command);
  tasks.shift()?.();
  await waitForRun(store.ledger, launch.run_id, "waiting_for_input");

  const pending = interruptRecord(launch.run_id);
  interrupts.set(pending.id, {
    ...pending,
    thread_id: launch.run_id
  });
  const waiting = await store.ledger.get(launch.run_id);
  if (waiting?.owner_id === undefined) throw new Error("Expected waiting owner");
  const resuming = await store.ledger.appendTransition({
    run_id: launch.run_id,
    transition_id: "simulate-initial-wait-projection-loss",
    event_id: "event-simulate-initial-wait-projection-loss",
    expected_revision: waiting.record_revision,
    occurred_at: new Date(BASE_TIME + 21_000).toISOString(),
    transition: {
      kind: "runtime_status",
      owner_id: waiting.owner_id,
      status: "resuming",
      active_node_ids: []
    }
  });
  await store.ledger.appendTransition({
    run_id: launch.run_id,
    transition_id: "simulate-stale-initial-owner",
    event_id: "event-simulate-stale-initial-owner",
    expected_revision: resuming.record.record_revision,
    occurred_at: new Date(BASE_TIME + 21_500).toISOString(),
    transition: {
      kind: "runtime_status",
      owner_id: waiting.owner_id,
      status: "running",
      active_node_ids: []
    }
  });
  await crashed.close();
  if (waitingState === undefined) throw new Error("Expected waiting runtime state");
  return {
    fixture,
    store,
    graphRoot,
    interrupts,
    durableInterrupts,
    waitingState,
    runId: launch.run_id
  };
}

async function recover(
  setup: CrashedWaitingRun,
  options: {
    readonly graphStore?: RunGraphSnapshotStorePort;
    readonly recoverWaitingWorkflow?: NonNullable<
      NonNullable<
        ConstructorParameters<typeof NativeStudioRunDispatcher>[0]["resume"]
      >["recoverWaitingWorkflow"]
    >;
  } = {}
) {
  const tasks: Array<() => void> = [];
  const errors: unknown[] = [];
  let initialExecutions = 0;
  const recoveryJournal = new NativeStudioRunRecoveryJournal({
    queueRoot: setup.fixture.queueRoot
  });
  const dispatcher = new NativeStudioRunDispatcher({
    projectRoot: setup.fixture.projectRoot,
    configRoot: setup.fixture.configRoot,
    queueRoot: setup.fixture.queueRoot,
    graphRoot: setup.graphRoot,
    ...(options.graphStore === undefined ? {} : { graphStore: options.graphStore }),
    recoveryJournal,
    ledger: setup.store.ledger,
    platform: nativeLunaPlatformRegistrations,
    now: () => BASE_TIME + 40_000,
    ownerId: "initial-wait-recovery-owner",
    heartbeatIntervalMs: 1_000,
    orphanThresholdMs: 3_000,
    schedule: (task) => tasks.push(task),
    onBackgroundError: (cause) => errors.push(cause),
    runWorkflow: async () => {
      initialExecutions += 1;
      throw new Error("Initial workflow must not replay for wait recovery");
    },
    resume: {
      interrupts: setup.durableInterrupts,
      journal: setup.store.resumes,
      platform: nativeLunaPlatformRegistrations,
      ...(options.recoverWaitingWorkflow === undefined
        ? {}
        : { recoverWaitingWorkflow: options.recoverWaitingWorkflow })
    }
  });
  await dispatcher.initialize();
  return { dispatcher, tasks, errors, initialExecutions: () => initialExecutions, recoveryJournal };
}

describe("native Studio initial waiting recovery", () => {
  it("binds an exact intent and reprojects waiting without replaying a node", async () => {
    const setup = await createCrashedWaitingRun();
    let recoveries = 0;
    const recovered = await recover(setup, {
      recoverWaitingWorkflow: async (input): Promise<WorkflowRunResult> => {
        recoveries += 1;
        expect(input).toMatchObject({
          thread_id: setup.runId,
          checkpoint_id: "checkpoint-1",
          interrupt_id: "interrupt-1"
        });
        const waiting = {
          status: "waiting_for_input" as const,
          interrupt_id: "interrupt-1",
          checkpoint_id: "checkpoint-1",
          state: setup.waitingState
        };
        await input.onWaitingState?.(waiting);
        return waiting;
      }
    });
    try {
      expect(recovered.tasks).toHaveLength(1);
      const intent = await recovered.recoveryJournal.read(setup.runId);
      expect(intent).toMatchObject({
        reason: "waiting_boundary_recovery_required",
        interrupt_id: "interrupt-1",
        checkpoint_id: "checkpoint-1"
      });
      recovered.tasks.splice(0).forEach((task) => task());
      await waitForRun(setup.store.ledger, setup.runId, "waiting_for_input");
      expect(recoveries).toBe(1);
      expect(recovered.initialExecutions()).toBe(0);
      expect(setup.interrupts.get("interrupt-1")).toMatchObject({ status: "pending" });
    } finally {
      await recovered.dispatcher.close();
      setup.store.close();
    }
  });

  it("terminalizes a claimed recovery when its pinned graph is missing", async () => {
    const setup = await createCrashedWaitingRun();
    const graphStore: RunGraphSnapshotStorePort = {
      async initialize() {},
      async writeGraph() {},
      async writeOutcome() {},
      async readGraph() { return { kind: "missing" }; },
      async readOutcome() { return { kind: "missing" }; }
    };
    const recovered = await recover(setup, { graphStore });
    try {
      recovered.tasks.splice(0).forEach((task) => task());
      await waitForRun(setup.store.ledger, setup.runId, "outcome_unknown");
      expect(await setup.store.ledger.get(setup.runId)).toMatchObject({
        failure: { code: "studio_runtime_waiting_graph_invalid" }
      });
      expect(recovered.initialExecutions()).toBe(0);
    } finally {
      await recovered.dispatcher.close();
      setup.store.close();
    }
  });

  it("terminalizes an invalid checkpoint or interrupt boundary without retry churn", async () => {
    const setup = await createCrashedWaitingRun();
    const recovered = await recover(setup, {
      recoverWaitingWorkflow: async () => {
        throw runtimeError("Interrupt is no longer pending", "interrupt_stale");
      }
    });
    try {
      recovered.tasks.splice(0).forEach((task) => task());
      await waitForRun(setup.store.ledger, setup.runId, "outcome_unknown");
      expect(await setup.store.ledger.get(setup.runId)).toMatchObject({
        failure: { code: "studio_runtime_waiting_boundary_invalid" }
      });
      expect(recovered.initialExecutions()).toBe(0);
    } finally {
      await recovered.dispatcher.close();
      setup.store.close();
    }
  });
});
