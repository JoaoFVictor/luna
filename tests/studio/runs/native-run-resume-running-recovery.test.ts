import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterruptRecord } from "../../../src/core/runtime/interrupts/contracts.js";
import type { LunaRuntimeState } from "../../../src/core/runtime/state.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
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

describe("native Studio running resume recovery", () => {
  it("reclaims a stale running resume after restart without replaying the initial job", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const interrupts = new Map<string, InterruptRecord>();
    const durableInterrupts = interruptPort(interrupts);
    const firstTasks: Array<() => void> = [];
    let waitingState: LunaRuntimeState | undefined;
    const first = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "running-resume-crashed-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => firstTasks.push(task),
      runWorkflow: async (input) => {
        const result = await waitingResult(input);
        waitingState = result.state;
        return result;
      },
      resume: {
        interrupts: durableInterrupts,
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

      const resuming = await store.ledger.get(launch.run_id);
      if (resuming?.owner_id === undefined) {
        throw new Error("Expected owned resuming run");
      }
      await store.ledger.appendTransition({
        run_id: launch.run_id,
        transition_id: "simulate-crash-after-start-resume",
        event_id: "event-simulate-crash-after-start-resume",
        expected_revision: resuming.record_revision,
        occurred_at: new Date(BASE_TIME + 21_000).toISOString(),
        transition: {
          kind: "runtime_status",
          owner_id: resuming.owner_id,
          status: "running",
          active_node_ids: []
        }
      });
      const claimedInterrupt = interrupts.get(interrupt.id);
      if (
        claimedInterrupt?.resume_attempt === undefined ||
        claimedInterrupt.resume_input === undefined
      ) {
        throw new Error("Expected claimed interrupt resume");
      }
      interrupts.set(interrupt.id, {
        ...claimedInterrupt,
        status: "resolved",
        resume_input: undefined,
        resume: {
          interrupt_id: interrupt.id,
          resume_id: claimedInterrupt.resume_attempt,
          input: claimedInterrupt.resume_input,
          decision: claimedInterrupt.resume_input.decision,
          created_at: new Date(BASE_TIME + 21_000).toISOString()
        },
        updated_at: new Date(BASE_TIME + 21_000).toISOString()
      });
      expect(firstTasks).toHaveLength(1);
      expect(await store.ledger.get(launch.run_id)).toMatchObject({
        run_status: "running",
        owner_id: "running-resume-crashed-owner"
      });
    } finally {
      await first.close();
    }

    if (runId === undefined || waitingState === undefined) {
      throw new Error("Expected launched waiting run");
    }
    const healthyOwnerTasks: Array<() => void> = [];
    let healthyOwnerExecutions = 0;
    const healthyOwnerObserver = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 22_000,
      ownerId: "running-resume-observer",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => healthyOwnerTasks.push(task),
      runWorkflow: async () => {
        healthyOwnerExecutions += 1;
        throw new Error("Healthy initial owner must not be displaced");
      },
      resume: {
        interrupts: durableInterrupts,
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async () => {
          healthyOwnerExecutions += 1;
          throw new Error("Healthy resume owner must not be displaced");
        }
      }
    });
    try {
      await healthyOwnerObserver.initialize();
      expect(healthyOwnerTasks).toHaveLength(0);
      expect(healthyOwnerExecutions).toBe(0);
      expect(await store.ledger.get(runId)).toMatchObject({
        run_status: "running",
        owner_id: "running-resume-crashed-owner"
      });
    } finally {
      await healthyOwnerObserver.close();
    }

    const recoveryTasks: Array<() => void> = [];
    const backgroundErrors: unknown[] = [];
    let initialExecutions = 0;
    let resumeExecutions = 0;
    let committedEffects = 0;
    const recovered = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 40_000,
      ownerId: "running-resume-recovery-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => recoveryTasks.push(task),
      onBackgroundError: (cause) => backgroundErrors.push(cause),
      runWorkflow: async () => {
        initialExecutions += 1;
        throw new Error("Initial run must never replay for queued resume recovery");
      },
      resume: {
        interrupts: durableInterrupts,
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async (input) => {
          resumeExecutions += 1;
          committedEffects += 1;
          const current = interrupts.get(input.interrupt_id);
          if (current?.status !== "resolved" || current.resume === undefined) {
            throw new Error("Expected durable resolved resume");
          }
          expect(current.resume.input).toMatchObject({
            thread_id: input.thread_id,
            checkpoint_id: input.checkpoint_id,
            decision: input.decision
          });
          const state = succeededResumeState(waitingState!);
          await input.onSucceededState?.(state);
          return { status: "succeeded", output: {}, state };
        }
      }
    });
    try {
      await recovered.initialize();
      expect(backgroundErrors).toHaveLength(0);
      expect(recoveryTasks).toHaveLength(1);
      expect(initialExecutions).toBe(0);
      expect(await store.ledger.get(runId)).toMatchObject({
        run_status: "running",
        owner_id: "running-resume-recovery-owner"
      });

      recoveryTasks.splice(0).forEach((task) => task());
      await waitForRun(store.ledger, runId, "succeeded");

      expect(initialExecutions).toBe(0);
      expect(resumeExecutions).toBe(1);
      expect(committedEffects).toBe(1);
      expect(interrupts.get("interrupt-1")).toMatchObject({
        status: "resolved",
        resume_attempt: expect.stringMatching(/^resume-/),
        resume: { decision: { action: "approve" } }
      });
      expect(await readdir(path.join(fixture.queueRoot, "resumes"))).toHaveLength(0);
      const record = await store.ledger.get(runId);
      expect(record).toMatchObject({ run_status: "succeeded" });
      expect(record?.failure).toBeUndefined();
    } finally {
      await recovered.close();
      store.close();
    }
  });
});
