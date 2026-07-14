import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterruptRecord } from "../../../src/core/runtime/interrupts/contracts.js";
import { officialCapabilityManifests } from "../../../src/capabilities/registry.js";
import {
  createNativeLunaPlatformRegistrations,
  nativeLunaPlatformRegistrations
} from "../../../src/platform/native/native-platform-registrations.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import {
  BASE_TIME,
  captureCommand,
  cleanupNativeLaunchFixtures,
  writeFixture
} from "./native-run-launch-test-support.js";
import {
  driftedCapabilityPlatform,
  interruptPort,
  interruptRecord,
  waitingResult
} from "./native-run-resume-test-support.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

describe("native Studio resume catalog drift", () => {
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
        journal: store.resumes,
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

  it("durably cancels a claimed resume on post-accept catalog drift and finishes cleanup after restart", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const scheduled: Array<() => void> = [];
    const interrupts = new Map<string, InterruptRecord>();
    const durableInterruptPort = interruptPort(interrupts);
    const [firstManifest, ...remainingManifests] = officialCapabilityManifests;
    if (firstManifest === undefined) throw new Error("Expected official capabilities");
    const driftedPlatform = createNativeLunaPlatformRegistrations({
      baseCapabilityManifests: [
        { ...firstManifest, version: "999.0.0" },
        ...remainingManifests
      ]
    });
    let catalogDrifted = false;
    const switchingPlatform = new Proxy(nativeLunaPlatformRegistrations, {
      get(_target, property) {
        return Reflect.get(
          catalogDrifted ? driftedPlatform : nativeLunaPlatformRegistrations,
          property
        );
      }
    });
    let resumeExecutions = 0;
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "resume-post-accept-drift-worker",
      schedule: (task) => scheduled.push(task),
      runWorkflow: waitingResult,
      resume: {
        interrupts: {
          ...durableInterruptPort,
          completeResume: async () => {
            throw new Error("simulated crash before interrupt cancellation");
          }
        },
        journal: store.resumes,
        platform: switchingPlatform,
        runWorkflow: async () => {
          resumeExecutions += 1;
          throw new Error("Unsafe resume must not execute");
        }
      }
    });
    let runId: string | undefined;
    try {
      await dispatcher.initialize();
      const launch = await dispatcher.dispatch(command);
      runId = launch.run_id;
      scheduled.shift()?.();
      await vi.waitFor(async () => {
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: "waiting_for_input"
        });
      });
      const interrupt = interruptRecord(launch.run_id);
      interrupts.set(interrupt.id, interrupt);

      await dispatcher.resume({
        runId: launch.run_id,
        interrupt,
        decision: { action: "approve" }
      });
      expect(await store.ledger.get(launch.run_id)).toMatchObject({
        run_status: "resuming"
      });
      expect(interrupts.get(interrupt.id)).toMatchObject({
        status: "resuming"
      });
      expect(scheduled).toHaveLength(1);

      catalogDrifted = true;
      scheduled.shift()?.();
      await vi.waitFor(async () => {
        expect(await store.ledger.get(launch.run_id)).toMatchObject({
          run_status: "cancelled"
        });
      });
      await dispatcher.close();

      expect(resumeExecutions).toBe(0);
      expect(await store.ledger.get(launch.run_id)).toMatchObject({
        run_status: "cancelled",
        failure: { code: "studio_run_resume_catalog_changed" }
      });
      expect(interrupts.get(interrupt.id)).toMatchObject({ status: "resuming" });
      expect(await store.resumes.list()).toHaveLength(1);
    } finally {
      await dispatcher.close();
    }

    if (runId === undefined) throw new Error("Expected launched run");
    const recoveryTasks: Array<() => void> = [];
    const recovered = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 40_000,
      ownerId: "resume-post-accept-drift-recovery",
      schedule: (task) => recoveryTasks.push(task),
      runWorkflow: async () => { throw new Error("Initial run must not replay"); },
      resume: {
        interrupts: durableInterruptPort,
        journal: store.resumes,
        platform: driftedPlatform,
        runWorkflow: async () => {
          resumeExecutions += 1;
          throw new Error("Unsafe resume must not execute");
        }
      }
    });
    try {
      await recovered.initialize();
      expect(recoveryTasks).toHaveLength(0);
      expect(resumeExecutions).toBe(0);
      expect(await store.ledger.get(runId)).toMatchObject({
        run_status: "cancelled",
        failure: { code: "studio_run_resume_catalog_changed" }
      });
      expect(interrupts.get("interrupt-1")).toMatchObject({
        status: "cancelled",
        resume_attempt: expect.stringMatching(/^resume-/)
      });
      expect(await store.resumes.list()).toHaveLength(0);
    } finally {
      await recovered.close();
      store.close();
    }
  });

  it("cancels a stale pre-effect running resume when the capability catalog changed", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const interrupts = new Map<string, InterruptRecord>();
    const durableInterrupts = interruptPort(interrupts);
    const firstTasks: Array<() => void> = [];
    const first = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "pre-effect-catalog-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => firstTasks.push(task),
      runWorkflow: waitingResult,
      resume: {
        interrupts: durableInterrupts,
        journal: store.resumes,
        platform: nativeLunaPlatformRegistrations
      }
    });
    let runId: string | undefined;
    try {
      await first.initialize();
      const launch = await first.dispatch(command);
      runId = launch.run_id;
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
      const record = await store.ledger.get(launch.run_id);
      if (record?.owner_id === undefined) throw new Error("Expected resume owner");
      await store.ledger.appendTransition({
        run_id: launch.run_id,
        transition_id: "simulate-pre-effect-catalog-running",
        event_id: "event-simulate-pre-effect-catalog-running",
        expected_revision: record.record_revision,
        occurred_at: new Date(BASE_TIME + 21_000).toISOString(),
        transition: {
          kind: "runtime_status",
          owner_id: record.owner_id,
          status: "running",
          active_node_ids: []
        }
      });
    } finally {
      await first.close();
    }
    if (runId === undefined) throw new Error("Expected launched run");

    const recoveryTasks: Array<() => void> = [];
    const recoveryErrors: unknown[] = [];
    let executions = 0;
    const recovered = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 40_000,
      ownerId: "pre-effect-catalog-recovery-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => recoveryTasks.push(task),
      onBackgroundError: (cause) => recoveryErrors.push(cause),
      runWorkflow: async () => {
        executions += 1;
        throw new Error("Initial workflow must not replay");
      },
      resume: {
        interrupts: durableInterrupts,
        journal: store.resumes,
        platform: driftedCapabilityPlatform(),
        runWorkflow: async () => {
          executions += 1;
          throw new Error("Changed catalog must not resume");
        }
      }
    });
    try {
      await recovered.initialize();
      expect(recoveryErrors).toEqual([]);
      expect(recoveryTasks).toHaveLength(0);
      expect(executions).toBe(0);
      expect(await store.ledger.get(runId)).toMatchObject({
        run_status: "cancelled",
        owner_id: "pre-effect-catalog-recovery-owner",
        failure: { code: "studio_run_resume_catalog_changed" }
      });
      expect(interrupts.get("interrupt-1")).toMatchObject({ status: "cancelled" });
      expect(await store.resumes.list()).toHaveLength(0);
    } finally {
      await recovered.close();
      store.close();
    }
  });
});
