import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterruptRecord } from "../../../src/core/runtime/interrupts/contracts.js";
import type { LunaRuntimeState } from "../../../src/core/runtime/state.js";
import { sha256Digest } from "../../../src/core/workflow/definition-digests.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { RunGraphService } from "../../../src/studio/application/runs/graph-service.js";
import { studioRunResumeCommandMaterial } from "../../../src/studio/application/runs/resume-journal.js";
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
import {
  interruptPort,
  interruptRecord,
  succeededResumeState,
  waitingResult
} from "./native-run-resume-test-support.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

describe("native Studio resume acceptance and observability", () => {
  it("lets the workflow runtime exclusively own the non-reentrant resume lease", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    const interrupts = new Map<string, InterruptRecord>();
    const baseInterrupts = interruptPort(interrupts);
    const leasedRunIds = new Set<string>();
    let runtimeLeaseAcquisitions = 0;
    const durableInterrupts = {
      ...baseInterrupts,
      withResumeLease: async <T>(runId: string, operation: () => Promise<T>) => {
        if (leasedRunIds.has(runId)) {
          throw new Error("non-reentrant resume lease acquired twice");
        }
        leasedRunIds.add(runId);
        runtimeLeaseAcquisitions += 1;
        try {
          return await operation();
        } finally {
          leasedRunIds.delete(runId);
        }
      }
    };
    let waitingState: LunaRuntimeState | undefined;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "runtime-resume-lease-owner",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => {
        const result = await waitingResult(input);
        waitingState = result.state;
        return result;
      },
      resume: {
        interrupts: durableInterrupts,
        journal: store.resumes,
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async (input) => await durableInterrupts.withResumeLease(
          input.thread_id,
          async () => {
            const current = interrupts.get(input.interrupt_id);
            if (
              current?.resume_attempt === undefined ||
              current.resume_input === undefined
            ) {
              throw new Error("Expected the durable Studio interrupt claim");
            }
            await durableInterrupts.completeResume(
              current.id,
              { resume_attempt: current.resume_attempt },
              "resolved",
              {
                interrupt_id: current.id,
                resume_id: current.resume_attempt,
                input: current.resume_input,
                decision: input.decision,
                created_at: new Date(BASE_TIME + 30_000).toISOString()
              }
            );
            const state = succeededResumeState(waitingState!);
            await input.onSucceededState?.(state);
            return { status: "succeeded", output: {}, state };
          }
        )
      }
    });
    try {
      await dispatcher.initialize();
      const launch = await dispatcher.dispatch(command);
      scheduled.shift()?.();
      await waitForRun(store.ledger, launch.run_id, "waiting_for_input");
      const original = interruptRecord(launch.run_id);
      const interrupt = {
        ...original,
        thread_id: launch.run_id,
        payload: {
          ...original.payload!,
          run: {
            ...original.payload!.run,
            run_id: launch.run_id
          }
        }
      } satisfies InterruptRecord;
      interrupts.set(interrupt.id, interrupt);

      await dispatcher.resume({
        runId: launch.run_id,
        interrupt,
        decision: { action: "approve" }
      });
      scheduled.splice(0).forEach((task) => task());
      await waitForRun(store.ledger, launch.run_id, "succeeded");

      expect(runtimeLeaseAcquisitions).toBe(1);
      expect(leasedRunIds).toEqual(new Set());
      expect(interrupts.get(interrupt.id)).toMatchObject({
        status: "resolved",
        resume: { decision: { action: "approve" } }
      });
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
        journal: store.resumes,
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async (input) => {
          await input.onLifecycleEvent?.(
            lifecycleEvent("2026-07-11T12:00:30.000Z")
          ).catch(() => undefined);
          await input.onWaitingState?.({
            state: waitingState!,
            interrupt_id: "interrupt-2",
            checkpoint_id: "checkpoint-2"
          });
          throw new Error("simulated crash after durable waiting projection");
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
      expect(interrupts.get(interrupt.id)).toMatchObject({
        status: "cancelled"
      });
      expect(await store.resumes.list()).toHaveLength(0);
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
    let now = BASE_TIME + 20_000;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => now,
      ownerId: "durable-resume-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: async (input) => {
        const result = await waitingResult(input);
        waitingState = result.state;
        return result;
      },
      resume: {
        interrupts: interruptPort(interrupts),
        journal: store.resumes,
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
      const acceptedResume = (await store.resumes.list())[0];
      expect(acceptedResume).toMatchObject({
        accepted_at: new Date(BASE_TIME + 20_000).toISOString()
      });
      now = BASE_TIME + 90_000;
      const duplicate = await dispatcher.resume({ runId: launch.run_id, interrupt, decision });
      expect((await store.resumes.list())[0]).toMatchObject({
        accepted_at: new Date(BASE_TIME + 20_000).toISOString()
      });
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
      const completed = await store.resumes.get(acceptedResume!.resume_id);
      expect(completed?.stage.kind).toBe("completed");
      const completedRetry = await store.resumes.accept(
        studioRunResumeCommandMaterial(completed!)
      );
      expect(completedRetry).toMatchObject({
        created: false,
        record: { stage: { kind: "completed" } }
      });
      const conflictingDecision = { action: "reject" };
      await expect(store.resumes.accept({
        ...studioRunResumeCommandMaterial(completed!),
        decision: conflictingDecision,
        decision_hash: sha256Digest(conflictingDecision)
      })).rejects.toMatchObject({ code: "run_idempotency_conflict" });
    } finally {
      await dispatcher.close();
      store.close();
    }
  });

  it.each(["missing", "corrupt", "identity_mismatch"] as const)(
    "tombstones a resume whose durable graph is %s without invoking runtime",
    async (graphFailure) => {
      const fixture = await writeFixture();
      const { command } = await captureCommand(fixture);
      const store = await createSqliteRunStore({ filePath: fixture.databasePath });
      const graphStore = new FilesystemRunGraphStore({
        root: path.join(fixture.root, `resume-${graphFailure}-graphs`)
      });
      const scheduled: Array<() => void> = [];
      const interrupts = new Map<string, InterruptRecord>();
      let resumeExecutions = 0;
      const dispatcher = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        ledger: store.ledger,
        graphStore,
        platform: nativeLunaPlatformRegistrations,
        now: () => BASE_TIME + 20_000,
        ownerId: `resume-${graphFailure}-worker`,
        schedule: (task) => scheduled.push(task),
        runWorkflow: waitingResult,
        resume: {
          interrupts: interruptPort(interrupts),
          journal: store.resumes,
          platform: nativeLunaPlatformRegistrations,
          runWorkflow: async () => {
            resumeExecutions += 1;
            throw new Error("Runtime must not execute without its durable graph");
          }
        }
      });
      try {
        await dispatcher.initialize();
        const launch = await dispatcher.dispatch(command);
        scheduled.shift()?.();
        await waitForRun(store.ledger, launch.run_id, "waiting_for_input");
        const interrupt = interruptRecord(launch.run_id);
        interrupts.set(interrupt.id, interrupt);
        if (graphFailure === "identity_mismatch") {
          const record = await store.ledger.get(launch.run_id);
          const stored = await graphStore.readGraph(
            record!.graph_snapshot_handle!
          );
          if (stored.kind !== "available") {
            throw new Error("Expected the launched run graph");
          }
          vi.spyOn(graphStore, "readGraph").mockResolvedValue({
            kind: "available",
            value: {
              ...stored.value,
              identity: {
                ...stored.value.identity,
                run_id: "different-run"
              }
            }
          });
        } else {
          vi.spyOn(graphStore, "readGraph").mockResolvedValue({
            kind: graphFailure
          });
        }

        await dispatcher.resume({
          runId: launch.run_id,
          interrupt,
          decision: { action: "approve" }
        });
        const resume = (await store.resumes.list())[0];
        if (graphFailure === "identity_mismatch") {
          const claimed = interrupts.get(interrupt.id)!;
          interrupts.set(interrupt.id, {
            ...claimed,
            status: "resolved",
            resume_input: undefined,
            resume: {
              interrupt_id: interrupt.id,
              resume_id: claimed.resume_attempt!,
              input: claimed.resume_input!,
              decision: claimed.resume_input!.decision,
              created_at: new Date(BASE_TIME + 21_000).toISOString()
            }
          });
        }
        scheduled.splice(0).forEach((task) => task());
        await waitForRun(store.ledger, launch.run_id, "outcome_unknown");

        expect(resumeExecutions).toBe(0);
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          failure: { code: "studio_runtime_resume_graph_invalid" }
        });
        expect(interrupts.get(interrupt.id)).toMatchObject({
          status: graphFailure === "identity_mismatch"
            ? "resolved"
            : "cancelled",
          resume_attempt: resume!.resume_id,
          resume_input: undefined
        });
        expect(await store.resumes.list()).toHaveLength(0);
        expect(await store.resumes.get(resume!.resume_id)).toMatchObject({
          stage: { kind: "completed" }
        });
      } finally {
        await dispatcher.close();
        store.close();
      }
    }
  );

  it.each([
    [false, "cancelled", undefined],
    [true, "outcome_unknown", "studio_runtime_resume_interrupt_missing"]
  ] as const)(
    "converges a missing interrupt (effect may have occurred: %s)",
    async (effectMayHaveOccurred, expectedStatus, expectedCode) => {
      const fixture = await writeFixture();
      const { command } = await captureCommand(fixture);
      const store = await createSqliteRunStore({ filePath: fixture.databasePath });
      const scheduled: Array<() => void> = [];
      const interrupts = new Map<string, InterruptRecord>();
      let resumeExecutions = 0;
      const dispatcher = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        ledger: store.ledger,
        platform: nativeLunaPlatformRegistrations,
        now: () => BASE_TIME + 20_000,
        ownerId: "missing-interrupt-worker",
        schedule: (task) => scheduled.push(task),
        runWorkflow: waitingResult,
        resume: {
          interrupts: interruptPort(interrupts),
          journal: store.resumes,
          platform: nativeLunaPlatformRegistrations,
          runWorkflow: async () => {
            resumeExecutions += 1;
            throw new Error("Runtime must not execute without its interrupt");
          }
        }
      });
      try {
        await dispatcher.initialize();
        const launch = await dispatcher.dispatch(command);
        scheduled.shift()?.();
        await waitForRun(store.ledger, launch.run_id, "waiting_for_input");
        const interrupt = interruptRecord(launch.run_id);
        interrupts.set(interrupt.id, interrupt);
        await dispatcher.resume({
          runId: launch.run_id,
          interrupt,
          decision: { action: "approve" }
        });
        const resume = (await store.resumes.list())[0]!;
        if (effectMayHaveOccurred) {
          await store.resumes.markEffectMayHaveOccurred({
            resume_id: resume.resume_id,
            command_hash: resume.command_hash,
            node_id: "effectful-node"
          });
        }
        interrupts.delete(interrupt.id);
        scheduled.splice(0).forEach((task) => task());
        await waitForRun(store.ledger, launch.run_id, expectedStatus);

        expect(resumeExecutions).toBe(0);
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: expectedStatus,
          ...(expectedCode === undefined
            ? {}
            : { failure: { code: expectedCode } })
        });
        expect(await store.resumes.get(resume.resume_id)).toMatchObject({
          stage: { kind: "completed" }
        });
      } finally {
        await dispatcher.close();
        store.close();
      }
    }
  );

  it.each(["missing", "corrupt"] as const)(
    "cancels a pre-execution resume whose immutable source job is %s",
    async (sourceFailure) => {
      const fixture = await writeFixture();
      const { command } = await captureCommand(fixture);
      const store = await createSqliteRunStore({ filePath: fixture.databasePath });
      const scheduled: Array<() => void> = [];
      const interrupts = new Map<string, InterruptRecord>();
      const backgroundErrors: unknown[] = [];
      let resumeExecutions = 0;
      const dispatcher = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        ledger: store.ledger,
        platform: nativeLunaPlatformRegistrations,
        now: () => BASE_TIME + 20_000,
        ownerId: `missing-source-${sourceFailure}-worker`,
        schedule: (task) => scheduled.push(task),
        onBackgroundError: (cause) => backgroundErrors.push(cause),
        runWorkflow: waitingResult,
        resume: {
          interrupts: interruptPort(interrupts),
          journal: store.resumes,
          platform: nativeLunaPlatformRegistrations,
          runWorkflow: async () => {
            resumeExecutions += 1;
            throw new Error("Runtime must not execute without its source job");
          }
        }
      });
      try {
        await dispatcher.initialize();
        const launch = await dispatcher.dispatch(command);
        scheduled.shift()?.();
        await waitForRun(store.ledger, launch.run_id, "waiting_for_input");
        const interrupt = interruptRecord(launch.run_id);
        interrupts.set(interrupt.id, interrupt);
        await dispatcher.resume({
          runId: launch.run_id,
          interrupt,
          decision: { action: "approve" }
        });
        const resume = (await store.resumes.list())[0]!;
        const jobDirectory = path.join(
          fixture.queueRoot,
          "jobs",
          launch.run_id
        );
        const jobFile = path.join(jobDirectory, "job.json");
        if (sourceFailure === "missing") {
          await rm(jobFile);
        } else {
          await writeFile(jobFile, "{invalid");
        }
        scheduled.splice(0).forEach((task) => task());
        await waitForRun(store.ledger, launch.run_id, "cancelled");

        expect(backgroundErrors).toEqual([]);
        expect(resumeExecutions).toBe(0);
        expect(interrupts.get(interrupt.id)).toMatchObject({
          status: "cancelled"
        });
        expect(await store.resumes.get(resume.resume_id)).toMatchObject({
          stage: { kind: "completed" }
        });
      } finally {
        await dispatcher.close();
        store.close();
      }
    }
  );
});
