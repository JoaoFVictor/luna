import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterruptRecord } from "../../../src/core/runtime/interrupts/contracts.js";
import type { LunaRuntimeState } from "../../../src/core/runtime/state.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { NativeStudioRunDispatchQueue } from "../../../src/studio/adapters/filesystem/run-dispatch-queue.js";
import { nativeStudioQueuedResumeMaterial } from "../../../src/studio/adapters/filesystem/run-resume-contracts.js";
import { NativeStudioRunLease } from "../../../src/studio/adapters/native/run-dispatch-lease.js";
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

describe("native Studio resume checkpoint recovery", () => {
  it("keeps an intact resume immutable across transient recovery dependency failures", async () => {
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
      ownerId: "transient-resume-acceptor",
      schedule: (task) => firstTasks.push(task),
      runWorkflow: waitingResult,
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
    } finally {
      await first.close();
    }
    if (runId === undefined) throw new Error("Expected accepted resume");

    const assertIntact = async () => {
      expect(await store.ledger.get(runId!)).toMatchObject({ run_status: "resuming" });
      expect(interrupts.get("interrupt-1")).toMatchObject({ status: "resuming" });
      expect(await readdir(path.join(fixture.queueRoot, "resumes"))).toHaveLength(1);
      expect(await readdir(path.join(fixture.queueRoot, "resume-stages"))).toHaveLength(1);
      expect(await readdir(path.join(fixture.queueRoot, "resume-identities"))).toHaveLength(1);
      expect(await readdir(path.join(fixture.queueRoot, "resume-quarantine"))).toHaveLength(0);
    };
    const recoverOnce = async (options: {
      readonly ledger?: typeof store.ledger;
      readonly interruptGetFailure?: boolean;
    }) => {
      const tasks: Array<() => void> = [];
      const port = options.interruptGetFailure
        ? {
            ...durableInterrupts,
            get: async () => { throw new Error("transient interrupt read failure"); }
          }
        : durableInterrupts;
      const dispatcher = new NativeStudioRunDispatcher({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        queueRoot: fixture.queueRoot,
        ledger: options.ledger ?? store.ledger,
        platform: nativeLunaPlatformRegistrations,
        now: () => BASE_TIME + 40_000,
        ownerId: "transient-resume-observer",
        schedule: (task) => tasks.push(task),
        runWorkflow: async () => { throw new Error("Initial run must stay protected"); },
        resume: {
          interrupts: port,
          platform: nativeLunaPlatformRegistrations,
          runWorkflow: async () => { throw new Error("Transient failure must not execute"); }
        }
      });
      await dispatcher.initialize();
      expect(tasks).toHaveLength(0);
      await dispatcher.close();
    };

    const ledgerProxy = new Proxy(store.ledger, {
      get(target, property, receiver) {
        if (property === "get") {
          return async () => { throw new Error("transient ledger read failure"); };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    await recoverOnce({ ledger: ledgerProxy });
    await assertIntact();
    await recoverOnce({ interruptGetFailure: true });
    await assertIntact();

    const originalRead = NativeStudioRunDispatchQueue.prototype.read;
    const sourceRead = vi.spyOn(NativeStudioRunDispatchQueue.prototype, "read")
      .mockImplementation(async function (
        this: NativeStudioRunDispatchQueue,
        id: string
      ) {
        if (id === runId) throw new Error("transient source job read failure");
        return await originalRead.call(this, id);
      });
    try {
      await recoverOnce({});
    } finally {
      sourceRead.mockRestore();
    }
    await assertIntact();

    const retryTasks: Array<() => void> = [];
    const retry = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 50_000,
      ownerId: "transient-resume-retry",
      schedule: (task) => retryTasks.push(task),
      runWorkflow: async () => { throw new Error("Initial run must not replay"); },
      resume: {
        interrupts: durableInterrupts,
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async () => { throw new Error("Retry is scheduled, not executed in this test"); }
      }
    });
    try {
      await retry.initialize();
      expect(retryTasks).toHaveLength(1);
      await assertIntact();
    } finally {
      await retry.close();
      store.close();
    }
  });

  it("uses the integrity sidecar to terminalize a corrupt resume without initial-run adoption", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const interrupts = new Map<string, InterruptRecord>();
    const tasks: Array<() => void> = [];
    const first = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "corrupt-resume-acceptor",
      schedule: (task) => tasks.push(task),
      runWorkflow: waitingResult,
      resume: {
        interrupts: interruptPort(interrupts),
        platform: nativeLunaPlatformRegistrations
      }
    });
    let queuedResume: Awaited<ReturnType<NativeStudioRunDispatchQueue["readResume"]>> | undefined;
    let stageSource: string | undefined;
    let runId: string | undefined;
    try {
      await first.initialize();
      const launch = await first.dispatch(command);
      runId = launch.run_id;
      tasks.shift()?.();
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
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      const [resumeId] = await queue.listResumeIds();
      if (resumeId === undefined) throw new Error("Expected accepted resume");
      queuedResume = await queue.readResume(resumeId);
      expect(await queue.readResumeIdentity(resumeId)).toMatchObject({
        resume_id: resumeId,
        run_id: launch.run_id,
        interrupt_id: interrupt.id,
        command_hash: queuedResume.command_hash,
        identity_hash: expect.stringMatching(/^sha256:/)
      });
      const stagePath = path.join(fixture.queueRoot, "resume-stages", `${resumeId}.json`);
      stageSource = await readFile(stagePath, "utf8");
      await writeFile(
        path.join(fixture.queueRoot, "resumes", `${resumeId}.json`),
        "{not-json"
      );
    } finally {
      await first.close();
    }

    if (queuedResume === undefined || stageSource === undefined || runId === undefined) {
      throw new Error("Expected corrupt resume fixture");
    }
    const recoveryTasks: Array<() => void> = [];
    let initialExecutions = 0;
    let resumeExecutions = 0;
    const backgroundErrors: unknown[] = [];
    const recovered = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 40_000,
      ownerId: "corrupt-resume-recovery",
      schedule: (task) => recoveryTasks.push(task),
      onBackgroundError: (cause) => backgroundErrors.push(cause),
      runWorkflow: async () => {
        initialExecutions += 1;
        throw new Error("Corrupt resume must protect against initial adoption");
      },
      resume: {
        interrupts: interruptPort(interrupts),
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async () => {
          resumeExecutions += 1;
          throw new Error("Corrupt resume must not execute");
        }
      }
    });
    try {
      await recovered.initialize();
      expect(recoveryTasks).toHaveLength(0);
      expect(initialExecutions).toBe(0);
      expect(resumeExecutions).toBe(0);
      expect(await store.ledger.get(runId)).toMatchObject({
        run_status: "cancelled",
        failure: { code: "run_store_corrupt" }
      });
      expect(interrupts.get("interrupt-1")).toMatchObject({
        status: "cancelled",
        resume_attempt: queuedResume.resume_id
      });
      expect(backgroundErrors.length).toBeGreaterThanOrEqual(1);
      expect(await readdir(path.join(fixture.queueRoot, "resumes"))).toHaveLength(0);
      expect(await readdir(path.join(fixture.queueRoot, "resume-stages"))).toHaveLength(0);
      expect(await readdir(path.join(fixture.queueRoot, "resume-identities"))).toHaveLength(0);
      expect(await readdir(path.join(fixture.queueRoot, "resume-quarantine"))).toHaveLength(2);

      // A crash may leave the old stage after all authorities were cleaned.
      // Startup removes that orphan so the deterministic resume id can be
      // recreated without inheriting a prior command's replay classification.
      await writeFile(
        path.join(fixture.queueRoot, "resume-stages", `${queuedResume.resume_id}.json`),
        stageSource
      );
      const restartedQueue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      await restartedQueue.initialize();
      expect(await readdir(path.join(fixture.queueRoot, "resume-stages"))).toHaveLength(0);
      const recreated = await restartedQueue.acceptResume(
        nativeStudioQueuedResumeMaterial(queuedResume)
      );
      await restartedQueue.initializeResumeStage(recreated.job);
      expect(recreated.job.resume_id).toBe(queuedResume.resume_id);
      expect(await restartedQueue.readResumeStage(recreated.job)).toMatchObject({
        resume_id: queuedResume.resume_id,
        command_hash: queuedResume.command_hash,
        stage: "pre_execution"
      });
    } finally {
      await recovered.close();
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

  it("recovers the exact staged interrupt claim before transition and survives a later running crash", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const interrupts = new Map<string, InterruptRecord>();
    const durableInterrupts = interruptPort(interrupts);
    const beginAttempts: string[] = [];
    let remainingClaimFailures = 2;
    const crashableInterrupts = {
      ...durableInterrupts,
      beginResume: async (
        id: string,
        resumeAttempt: string,
        input: NonNullable<InterruptRecord["resume_input"]>
      ) => {
        beginAttempts.push(resumeAttempt);
        if (remainingClaimFailures > 0) {
          remainingClaimFailures -= 1;
          throw new Error("simulated crash after resume stage initialization");
        }
        return await durableInterrupts.beginResume(id, resumeAttempt, input);
      }
    };
    const firstTasks: Array<() => void> = [];
    let waitingState: LunaRuntimeState | undefined;
    const first = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 20_000,
      ownerId: "pre-claim-crashed-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => firstTasks.push(task),
      runWorkflow: async (input) => {
        const result = await waitingResult(input);
        waitingState = result.state;
        return result;
      },
      resume: {
        interrupts: crashableInterrupts,
        platform: nativeLunaPlatformRegistrations
      }
    });
    let runId: string | undefined;
    let queuedResume: Awaited<ReturnType<NativeStudioRunDispatchQueue["readResume"]>> | undefined;
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

      await expect(first.resume({
        runId: launch.run_id,
        interrupt,
        decision: { action: "approve" }
      })).rejects.toThrow("simulated crash after resume stage initialization");

      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      const [resumeId] = await queue.listResumeIds();
      if (resumeId === undefined) throw new Error("Expected durable queued resume");
      queuedResume = await queue.readResume(resumeId);
      const stage = await queue.readResumeStage(queuedResume);
      expect(stage).toMatchObject({
        resume_id: queuedResume.resume_id,
        command_hash: queuedResume.command_hash,
        stage: "pre_execution"
      });
      expect(queuedResume.decision_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(interrupts.get(interrupt.id)).toMatchObject({ status: "pending" });
      expect(await store.ledger.get(launch.run_id)).toMatchObject({
        run_status: "waiting_for_input"
      });
    } finally {
      await first.close();
    }

    if (runId === undefined || queuedResume === undefined || waitingState === undefined) {
      throw new Error("Expected staged resume fixture");
    }

    const transientTasks: Array<() => void> = [];
    const transient = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 25_000,
      ownerId: "claim-transient-observer",
      schedule: (task) => transientTasks.push(task),
      runWorkflow: async () => { throw new Error("Initial run must stay protected"); },
      resume: {
        interrupts: crashableInterrupts,
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async () => { throw new Error("Failed claim must not execute"); }
      }
    });
    try {
      await transient.initialize();
      expect(transientTasks).toHaveLength(0);
      expect(await store.ledger.get(runId)).toMatchObject({
        run_status: "waiting_for_input"
      });
      expect(interrupts.get("interrupt-1")).toMatchObject({ status: "pending" });
      expect(await readdir(path.join(fixture.queueRoot, "resumes"))).toHaveLength(1);
      expect(await readdir(path.join(fixture.queueRoot, "resume-stages"))).toHaveLength(1);
      expect(await readdir(path.join(fixture.queueRoot, "resume-identities"))).toHaveLength(1);
    } finally {
      await transient.close();
    }

    const claimedTasks: Array<() => void> = [];
    const claimant = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 30_000,
      ownerId: "claim-recovery-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => claimedTasks.push(task),
      runWorkflow: async () => { throw new Error("Initial run must not replay"); },
      resume: {
        interrupts: crashableInterrupts,
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async () => { throw new Error("Claim recovery must not execute eagerly"); }
      }
    });
    try {
      await claimant.initialize();
      expect(claimedTasks).toHaveLength(1);
      expect(interrupts.get("interrupt-1")).toMatchObject({
        status: "resuming",
        resume_attempt: queuedResume.resume_id,
        resume_input: {
          interrupt_id: queuedResume.interrupt_id,
          thread_id: queuedResume.thread_id,
          checkpoint_id: queuedResume.checkpoint_id,
          decision: queuedResume.decision
        }
      });
      expect(await store.ledger.get(runId)).toMatchObject({
        run_status: "waiting_for_input"
      });

      // Simulate the recovered owner crossing the running transition and then
      // crashing before workflow execution. The durable command and claim are
      // the only authority available to the next process.
      const crashingLease = new NativeStudioRunLease({
        ledger: store.ledger,
        runId,
        ownerId: queuedResume.owner_id,
        now: () => BASE_TIME + 31_000,
        heartbeatIntervalMs: 1_000,
        lifecycleExecutionId: queuedResume.resume_id
      });
      await crashingLease.resume();
      await crashingLease.releaseForRecovery();
      expect(await store.ledger.get(runId)).toMatchObject({
        run_status: "running",
        owner_id: queuedResume.owner_id
      });
    } finally {
      await claimant.close();
    }

    const recoveryTasks: Array<() => void> = [];
    let resumeExecutions = 0;
    const recovered = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 50_000,
      ownerId: "running-claim-recovery-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => recoveryTasks.push(task),
      runWorkflow: async () => { throw new Error("Initial run must not replay"); },
      resume: {
        interrupts: crashableInterrupts,
        platform: nativeLunaPlatformRegistrations,
        runWorkflow: async (input) => {
          resumeExecutions += 1;
          const claimed = interrupts.get(input.interrupt_id);
          if (
            claimed?.status !== "resuming" ||
            claimed.resume_attempt !== queuedResume!.resume_id ||
            claimed.resume_input === undefined
          ) {
            throw new Error("Expected exact durable interrupt claim");
          }
          interrupts.set(input.interrupt_id, {
            ...claimed,
            status: "resolved",
            resume_input: undefined,
            resume: {
              interrupt_id: input.interrupt_id,
              resume_id: claimed.resume_attempt,
              input: claimed.resume_input,
              decision: claimed.resume_input.decision,
              created_at: new Date(BASE_TIME + 50_000).toISOString()
            }
          });
          const state = succeededResumeState(waitingState!);
          await input.onSucceededState?.(state);
          return { status: "succeeded", output: {}, state };
        }
      }
    });
    try {
      await recovered.initialize();
      expect(recoveryTasks).toHaveLength(1);
      expect(await store.ledger.get(runId)).toMatchObject({
        run_status: "running",
        owner_id: "running-claim-recovery-owner"
      });
      recoveryTasks.splice(0).forEach((task) => task());
      await waitForRun(store.ledger, runId, "succeeded");
      expect(resumeExecutions).toBe(1);
      expect(beginAttempts).toEqual([
        queuedResume.resume_id,
        queuedResume.resume_id,
        queuedResume.resume_id
      ]);
      expect(interrupts.get("interrupt-1")).toMatchObject({
        status: "resolved",
        resume_attempt: queuedResume.resume_id,
        resume: {
          resume_id: queuedResume.resume_id,
          decision: queuedResume.decision
        }
      });
      await vi.waitFor(async () => {
        expect(await readdir(path.join(fixture.queueRoot, "resumes"))).toHaveLength(0);
        expect(await readdir(path.join(fixture.queueRoot, "resume-stages"))).toHaveLength(0);
      });
    } finally {
      await recovered.close();
      store.close();
    }
  });
});
