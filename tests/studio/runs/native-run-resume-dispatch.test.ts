import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterruptRecord } from "../../../src/core/runtime/interrupts/contracts.js";
import {
  markNodeWaitingForInput,
  startNodeAttempt,
  succeedNode
} from "../../../src/core/runtime/lifecycle.js";
import { createInitialRuntimeState, type LunaRuntimeState } from "../../../src/core/runtime/state.js";
import { officialCapabilityManifests } from "../../../src/capabilities/registry.js";
import { loadNativeRunContext } from "../../../src/platform/native/native-run-context.js";
import {
  createNativeLunaPlatformRegistrations,
  nativeLunaPlatformRegistrations
} from "../../../src/platform/native/native-platform-registrations.js";
import { RunGraphService } from "../../../src/studio/application/runs/graph-service.js";
import { FilesystemRunGraphStore } from "../../../src/studio/adapters/filesystem/run-graph-store.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import {
  BASE_TIME,
  captureCommand,
  cleanupNativeLaunchFixtures,
  waitForRun,
  writeFixture
} from "./native-run-launch-test-support.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

function interruptRecord(runId: string): InterruptRecord {
  const createdAt = new Date(BASE_TIME + 10_000).toISOString();
  return {
    id: "interrupt-1",
    run_id: runId,
    thread_id: "thread-1",
    checkpoint_id: "checkpoint-1",
    node_id: "analyze",
    status: "pending",
    created_at: createdAt,
    updated_at: createdAt,
    payload: {
      interrupt_id: "interrupt-1",
      run: {
        run_id: runId,
        workflow_id: "pinned-workflow",
        attempt: 1,
        started_at: new Date(BASE_TIME).toISOString(),
        source: "studio",
        event: "manual",
        target: { type: "workflow", id: "pinned-workflow" }
      },
      checkpoint_id: "checkpoint-1",
      node_id: "analyze",
      kind: "human_gate",
      prompt: "Review",
      decisions: [],
      created_at: createdAt
    }
  };
}

function interruptPort(interrupts: Map<string, InterruptRecord>) {
  return {
    get: async (id: string) => interrupts.get(id),
    beginResume: async (
      id: string,
      resumeAttempt: string,
      input: NonNullable<InterruptRecord["resume_input"]>
    ) => {
      const current = interrupts.get(id);
      if (current === undefined) throw new Error("interrupt missing");
      interrupts.set(id, {
        ...current,
        status: "resuming",
        resume_attempt: resumeAttempt,
        resume_input: input
      });
      return {
        interrupt_id: id,
        resume_attempt: resumeAttempt,
        status: "claimed" as const
      };
    }
  };
}

async function waitingResult(input: Parameters<ConstructorParameters<typeof NativeStudioRunDispatcher>[0]["runWorkflow"]>[0]) {
  if (input.run === undefined) throw new Error("Expected preallocated run");
  const context = await loadNativeRunContext(input, {
    platform: nativeLunaPlatformRegistrations
  });
  await input.onCompiledWorkflow?.(context.nativeWorkflow.compiled);
  let state = createInitialRuntimeState({
    invocation: input.invocation,
    config: input.workflowConfig ?? {},
    run: input.run,
    workflow: { id: "pinned-workflow", mode: "read_only" }
  });
  state = startNodeAttempt(state, "analyze", 1);
  state = markNodeWaitingForInput(state, "analyze");
  return {
    status: "waiting_for_input" as const,
    interrupt_id: "interrupt-1",
    checkpoint_id: "checkpoint-1",
    state
  };
}

function succeededResumeState(waiting: LunaRuntimeState): LunaRuntimeState {
  const analyzing = waiting.node_statuses.analyze;
  if (analyzing === undefined) throw new Error("Missing analyze node");
  const running: LunaRuntimeState = {
    ...waiting,
    run_status: "running",
    node_statuses: {
      ...waiting.node_statuses,
      analyze: { ...analyzing, status: "running" }
    }
  };
  return { ...succeedNode(running, "analyze"), run_status: "succeeded" };
}

describe("native Studio durable resume dispatch", () => {
  it("refuses catalog drift before claiming the interrupt or changing the run", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    const interrupts = new Map<string, InterruptRecord>();
    const [firstManifest, ...remainingManifests] = officialCapabilityManifests;
    if (firstManifest === undefined) throw new Error("Expected official capabilities");
    const driftedPlatform = createNativeLunaPlatformRegistrations({
      baseCapabilityManifests: [
        { ...firstManifest, version: "999.0.0" },
        ...remainingManifests
      ]
    });
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "resume-catalog-drift-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: waitingResult,
      resume: {
        interrupts: interruptPort(interrupts),
        platform: driftedPlatform,
        runWorkflow: async () => { throw new Error("Unsafe resume must not execute"); }
      }
    });
    try {
      await dispatcher.initialize();
      const launch = await dispatcher.dispatch(command);
      scheduled.shift()?.();
      await vi.waitFor(async () => {
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: "waiting_for_input"
        });
      });
      expect(scheduled).toHaveLength(0);
      const interrupt = interruptRecord(launch.run_id);
      interrupts.set(interrupt.id, interrupt);
      const before = await store.ledger.get(launch.run_id);

      await expect(dispatcher.resume({
        runId: launch.run_id,
        interrupt,
        decision: { action: "approve" }
      })).rejects.toMatchObject({
        code: "studio_run_resume_catalog_changed"
      });

      expect(await store.ledger.get(launch.run_id)).toEqual(before);
      expect(interrupts.get(interrupt.id)).toEqual(interrupt);
      expect(scheduled).toHaveLength(0);
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("keeps the live graph observable when a later resume reuses the runtime attempt number", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const graphStore = new FilesystemRunGraphStore({
      root: path.join(fixture.root, "resume-observable-graphs")
    });
    const scheduled: Array<() => void> = [];
    const interrupts = new Map<string, InterruptRecord>();
    let waitingState: LunaRuntimeState | undefined;
    const lifecycleEvent = (occurredAt: string) => ({
      type: "node.started" as const,
      node_id: "analyze",
      attempt: 1,
      occurred_at: occurredAt,
      artifact_count: 0,
      interrupt_count: 0
    });
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      graphStore,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "resume-observable-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => {
        const result = await waitingResult(input);
        waitingState = result.state;
        await input.onLifecycleEvent?.(
          lifecycleEvent("2026-07-11T12:00:10.000Z")
        );
        return result;
      },
      resume: {
        interrupts: interruptPort(interrupts),
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async (input) => {
          await input.onLifecycleEvent?.(
            lifecycleEvent("2026-07-11T12:00:30.000Z")
          ).catch(() => undefined);
          return {
            status: "waiting_for_input",
            interrupt_id: "interrupt-2",
            checkpoint_id: "checkpoint-2",
            state: waitingState!
          };
        }
      }
    });
    try {
      await dispatcher.initialize();
      const launch = await dispatcher.dispatch(command);
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: "waiting_for_input",
          lifecycle_projection: "exact"
        });
      });
      const interrupt = interruptRecord(launch.run_id);
      interrupts.set(interrupt.id, interrupt);

      await dispatcher.resume({
        runId: launch.run_id,
        interrupt,
        decision: { action: "approve" }
      });
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: "waiting_for_input",
          lifecycle_projection: "exact"
        });
      });

      const graph = await new RunGraphService({
        ledger: store.ledger,
        events: store.events,
        store: graphStore
      }).get(launch.run_id);
      expect(graph).toMatchObject({
        availability: "available",
        overlay: {
          observation: "observed",
          source: "live",
          nodes: [{
            node_id: "analyze",
            status: "waiting_for_input",
            attempt_count: 1
          }]
        }
      });
      const lifecycle = await store.events.list({
        run_id: launch.run_id,
        direction: "asc",
        event_types: ["run.node.started"],
        limit: 10
      });
      expect(lifecycle.items).toHaveLength(2);
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("durably accepts an exact duplicate and runs it once from the pinned snapshot", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    const interrupts = new Map<string, InterruptRecord>();
    let waitingState: LunaRuntimeState | undefined;
    let resumeExecutions = 0;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "durable-resume-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => {
        const result = await waitingResult(input);
        waitingState = result.state;
        return result;
      },
      resume: {
        interrupts: interruptPort(interrupts),
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async (input) => {
          resumeExecutions += 1;
          expect(input.definitionRoots).toBeDefined();
          const pinned = await readFile(path.join(
            input.definitionRoots!.projectRoot,
            "workflows",
            "pinned-workflow",
            "workflow.yaml"
          ), "utf8");
          expect(pinned).toBe(fixture.workflowSource);
          const state = succeededResumeState(waitingState!);
          const interrupt = interrupts.get("interrupt-1")!;
          interrupts.set("interrupt-1", {
            ...interrupt,
            status: "resolved",
            resume: {
              interrupt_id: interrupt.id,
              resume_id: "resume-interrupt-1",
              input: {
                interrupt_id: interrupt.id,
                thread_id: input.thread_id,
                checkpoint_id: input.checkpoint_id,
                decision: input.decision
              },
              decision: input.decision,
              created_at: new Date(BASE_TIME + 30_000).toISOString()
            },
            updated_at: new Date(BASE_TIME + 30_000).toISOString()
          });
          await input.onSucceededState?.(state);
          return { status: "succeeded", output: {}, state };
        }
      }
    });
    try {
      await dispatcher.initialize();
      const launch = await dispatcher.dispatch(command);
      scheduled.shift()?.();
      await vi.waitFor(async () => {
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: "waiting_for_input"
        });
      });
      const interrupt = interruptRecord(launch.run_id);
      interrupts.set(interrupt.id, interrupt);
      await writeFile(fixture.workflowPath, fixture.workflowSource.replace("pinned-workflow", "mutated-workflow"));

      const decision = { action: "approve" as const };
      const first = await dispatcher.resume({ runId: launch.run_id, interrupt, decision });
      const resumeFiles = await readdir(path.join(fixture.queueRoot, "resumes"));
      expect(resumeFiles).toHaveLength(1);
      expect(JSON.parse(await readFile(
        path.join(fixture.queueRoot, "resumes", resumeFiles[0]!),
        "utf8"
      ))).toMatchObject({
        accepted_at: new Date(BASE_TIME + 20_000).toISOString()
      });
      const duplicate = await dispatcher.resume({ runId: launch.run_id, interrupt, decision });
      await expect(dispatcher.resume({
        runId: launch.run_id,
        interrupt,
        decision: { action: "reject" }
      })).rejects.toMatchObject({ code: "run_idempotency_conflict" });

      expect(first).toMatchObject({ accepted: true, resume_status: "resuming", already_resumed: false });
      expect(duplicate).toMatchObject({ accepted: true, resume_status: "resuming", already_resumed: false });
      expect(resumeExecutions).toBe(0);
      expect(await store.ledger.get(launch.run_id)).toMatchObject({ run_status: "resuming" });
      expect(interrupts.get("interrupt-1")).toMatchObject({
        status: "resuming",
        resume_input: { decision }
      });

      scheduled.splice(0).forEach((task) => task());
      await waitForRun(store.ledger, launch.run_id, "succeeded");
      expect(resumeExecutions).toBe(1);
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it("recovers an accepted resume after restart before execution", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const interrupts = new Map<string, InterruptRecord>();
    const firstTasks: Array<() => void> = [];
    let waitingState: LunaRuntimeState | undefined;
    const first = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "resume-acceptor",
      schedule: (task) => firstTasks.push(task),
      runWorkflow: async (input) => {
        const result = await waitingResult(input);
        waitingState = result.state;
        return result;
      },
      resume: {
        interrupts: interruptPort(interrupts),
        platform: nativeLunaPlatformRegistrations
      }
    });
    try {
      await first.initialize();
      const launch = await first.dispatch(command);
      firstTasks.shift()?.();
      await vi.waitFor(async () => {
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: "waiting_for_input"
        });
      });
      const interrupt = interruptRecord(launch.run_id);
      interrupts.set(interrupt.id, interrupt);
      await first.resume({
        runId: launch.run_id,
        interrupt,
        decision: { action: "approve" }
      });
      expect(await store.ledger.get(launch.run_id)).toMatchObject({ run_status: "resuming" });
      await first.close();
      await writeFile(
        path.join(fixture.queueRoot, "resumes", "resume-corrupt.json"),
        "{not-json"
      );

      const recoveryTasks: Array<() => void> = [];
      const backgroundErrors: unknown[] = [];
      let executions = 0;
      const recovered = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        ledger: store.ledger,
        platform: nativeLunaPlatformRegistrations,
        now: () => BASE_TIME + 40_000,
        ownerId: "resume-recovery-worker",
        onBackgroundError: (cause) => backgroundErrors.push(cause),
        schedule: (task) => recoveryTasks.push(task),
        runWorkflow: async () => { throw new Error("Initial run must not replay"); },
        resume: {
          interrupts: interruptPort(interrupts),
          platform: nativeLunaPlatformRegistrations,
          runWorkflow: async (input) => {
            executions += 1;
            const state = succeededResumeState(waitingState!);
            await input.onSucceededState?.(state);
            return { status: "succeeded", output: {}, state };
          }
        }
      });
      try {
        await recovered.initialize();
        expect(backgroundErrors).toHaveLength(1);
        expect(recoveryTasks).toHaveLength(1);
        expect(await readdir(path.join(fixture.queueRoot, "resumes"))).not.toContain(
          "resume-corrupt.json"
        );
        expect(await readdir(path.join(fixture.queueRoot, "resume-quarantine"))).toHaveLength(1);
      } finally {
        await recovered.close();
      }

      const restartedTasks: Array<() => void> = [];
      const restartErrors: unknown[] = [];
      const restarted = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        ledger: store.ledger,
        platform: nativeLunaPlatformRegistrations,
        now: () => BASE_TIME + 50_000,
        ownerId: "resume-restarted-worker",
        onBackgroundError: (cause) => restartErrors.push(cause),
        schedule: (task) => restartedTasks.push(task),
        runWorkflow: async () => { throw new Error("Initial run must not replay"); },
        resume: {
          interrupts: interruptPort(interrupts),
          platform: nativeLunaPlatformRegistrations,
          runWorkflow: async (input) => {
            executions += 1;
            const state = succeededResumeState(waitingState!);
            await input.onSucceededState?.(state);
            return { status: "succeeded", output: {}, state };
          }
        }
      });
      try {
        await restarted.initialize();
        expect(restartErrors).toHaveLength(0);
        expect(restartedTasks).toHaveLength(1);
        restartedTasks.splice(0).forEach((task) => task());
        await waitForRun(store.ledger, launch.run_id, "succeeded");
        expect(executions).toBe(1);
      } finally {
        await restarted.close();
      }
    } finally {
      await first.close();
      store.close();
    }
  });
});
