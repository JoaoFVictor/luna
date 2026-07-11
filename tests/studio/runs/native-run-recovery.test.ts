import {
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeWorkflowRunInput } from "../../../src/runtime/composition/target-executor.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { NativeStudioRunDispatchQueue } from "../../../src/studio/adapters/filesystem/run-dispatch-queue.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import type { RunLedgerPort } from "../../../src/studio/application/runs/ports.js";
import {
  BASE_TIME,
  captureCommand,
  cleanupNativeLaunchFixtures,
  successfulResult,
  waitForRun,
  writeFixture
} from "./native-run-launch-test-support.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});
describe("native Studio run queue recovery", () => {
  it("recovers a durably queued run after restart without allocating a new id", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const firstStore = await createSqliteRunStore({
      filePath: fixture.databasePath
    });
    const abandonedTasks: Array<() => void> = [];
    const firstDispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: firstStore.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "worker-before-restart",
      schedule: (task) => abandonedTasks.push(task),
      runWorkflow: async (input) => await successfulResult(input)
    });
    await firstDispatcher.initialize();
    const receipt = await firstDispatcher.dispatch(command);
    expect((await firstStore.ledger.get(receipt.run_id))?.dispatch_status)
      .toBe("queued");
    await firstDispatcher.close();
    firstStore.close();

    const recoveredInputs: NativeWorkflowRunInput[] = [];
    const recoveryTasks: Array<() => void> = [];
    const recoveredStore = await createSqliteRunStore({
      filePath: fixture.databasePath
    });
    const recoveredDispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: recoveredStore.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "worker-after-restart",
      schedule: (task) => recoveryTasks.push(task),
      runWorkflow: async (input) => {
        recoveredInputs.push(input);
        return await successfulResult(input);
      }
    });
    try {
      await recoveredDispatcher.initialize();
      expect(recoveryTasks).toHaveLength(1);
      recoveryTasks[0]?.();
      await waitForRun(recoveredStore.ledger, receipt.run_id, "succeeded");
      expect(recoveredInputs).toHaveLength(1);
      expect(recoveredInputs[0]?.run?.run_id).toBe(receipt.run_id);
    } finally {
      await recoveredDispatcher.close();
      recoveredStore.close();
    }
  });

  it("recovers the queue-before-ledger crash window from durable material", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const abandonedTasks: Array<() => void> = [];
    const failingLedger: RunLedgerPort = {
      preallocate: async () => {
        throw new Error("simulated crash before ledger preallocation");
      },
      appendTransition: async (input) =>
        await store.ledger.appendTransition(input),
      get: async (runId) => await store.ledger.get(runId),
      listOrphanCandidates: async (input) =>
        await store.ledger.listOrphanCandidates(input)
    };
    const interruptedDispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: failingLedger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "worker-before-ledger",
      schedule: (task) => abandonedTasks.push(task),
      runWorkflow: async (input) => await successfulResult(input)
    });
    await interruptedDispatcher.initialize();
    await expect(interruptedDispatcher.dispatch(command)).rejects.toThrow(
      "simulated crash before ledger preallocation"
    );

    const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
    await queue.initialize();
    const [durableRunId] = await queue.listRunIds();
    expect(durableRunId).toBeDefined();
    expect(await store.ledger.get(durableRunId ?? "missing")).toBeUndefined();
    await interruptedDispatcher.close();

    const recoveryTasks: Array<() => void> = [];
    const recoveredDispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "worker-after-ledger",
      schedule: (task) => recoveryTasks.push(task),
      runWorkflow: async (input) => await successfulResult(input)
    });
    try {
      await recoveredDispatcher.initialize();
      expect(recoveryTasks).toHaveLength(1);
      recoveryTasks[0]?.();
      await waitForRun(store.ledger, durableRunId ?? "missing", "succeeded");
    } finally {
      await recoveredDispatcher.close();
      store.close();
    }
  });

  it("does not reject a queued run when recovery hits a transient ledger failure", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const abandonedTasks: Array<() => void> = [];
    const firstDispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "worker-before-transient-failure",
      schedule: (task) => abandonedTasks.push(task),
      runWorkflow: async (input) => await successfulResult(input)
    });
    await firstDispatcher.initialize();
    const receipt = await firstDispatcher.dispatch(command);
    await firstDispatcher.close();

    let failNextRead = true;
    const transientLedger: RunLedgerPort = {
      preallocate: async (input) => await store.ledger.preallocate(input),
      appendTransition: async (input) =>
        await store.ledger.appendTransition(input),
      get: async (runId) => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error("simulated transient ledger read failure");
        }
        return await store.ledger.get(runId);
      },
      listOrphanCandidates: async (input) =>
        await store.ledger.listOrphanCandidates(input)
    };
    const interruptedRecoveryTasks: Array<() => void> = [];
    const interruptedRecovery = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: transientLedger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "worker-with-transient-failure",
      schedule: (task) => interruptedRecoveryTasks.push(task),
      runWorkflow: async (input) => await successfulResult(input),
      onBackgroundError: () => undefined
    });
    await interruptedRecovery.initialize();
    expect(interruptedRecoveryTasks).toHaveLength(0);
    expect((await store.ledger.get(receipt.run_id))?.dispatch_status)
      .toBe("queued");
    await interruptedRecovery.close();

    const recoveredTasks: Array<() => void> = [];
    const recoveredDispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "worker-after-transient-failure",
      schedule: (task) => recoveredTasks.push(task),
      runWorkflow: async (input) => await successfulResult(input)
    });
    try {
      await recoveredDispatcher.initialize();
      expect(recoveredTasks).toHaveLength(1);
      recoveredTasks[0]?.();
      await waitForRun(store.ledger, receipt.run_id, "succeeded");
    } finally {
      await recoveredDispatcher.close();
      store.close();
    }
  });

  it.each([
    "invalid_job_json",
    "symlinked_job_json",
    "missing_snapshot_file",
    "symlinked_snapshot_root"
  ] as const)("rejects a queued run when durable material proves %s corruption", async (corruption) => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const abandonedTasks: Array<() => void> = [];
    const firstDispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "worker-before-corruption",
      schedule: (task) => abandonedTasks.push(task),
      runWorkflow: async (input) => await successfulResult(input)
    });
    await firstDispatcher.initialize();
    const receipt = await firstDispatcher.dispatch(command);
    await firstDispatcher.close();
    const jobDirectory = path.join(
      fixture.queueRoot,
      "jobs",
      receipt.run_id
    );
    const jobPath = path.join(jobDirectory, "job.json");
    if (corruption === "invalid_job_json") {
      await writeFile(jobPath, "not-json");
    } else if (corruption === "symlinked_job_json") {
      const external = path.join(fixture.root, "external-job.json");
      await writeFile(external, "not-a-queue-job");
      await rm(jobPath);
      await symlink(external, jobPath);
    } else if (corruption === "missing_snapshot_file") {
      await rm(path.join(
        jobDirectory,
        "snapshot",
        "config",
        "models.yaml"
      ));
    } else {
      const configSnapshot = path.join(
        jobDirectory,
        "snapshot",
        "config"
      );
      const external = path.join(fixture.root, "external-config-snapshot");
      await mkdir(external);
      await rm(configSnapshot, { recursive: true });
      await symlink(external, configSnapshot, "dir");
    }

    const recoveryTasks: Array<() => void> = [];
    const recoveredDispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "worker-after-corruption",
      schedule: (task) => recoveryTasks.push(task),
      runWorkflow: async (input) => await successfulResult(input),
      onBackgroundError: () => undefined
    });
    try {
      await recoveredDispatcher.initialize();
      expect(recoveryTasks).toHaveLength(0);
      expect(await store.ledger.get(receipt.run_id)).toMatchObject({
        dispatch_status: "rejected",
        failure: { code: "studio_dispatch_snapshot_invalid" }
      });
    } finally {
      await recoveredDispatcher.close();
      store.close();
    }
  });

  it("isolates invalid queue siblings and safely cleans abandoned staging entries", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const abandonedTasks: Array<() => void> = [];
    const firstDispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      schedule: (task) => abandonedTasks.push(task),
      runWorkflow: async (input) => await successfulResult(input)
    });
    await firstDispatcher.initialize();
    const receipt = await firstDispatcher.dispatch(command);
    await firstDispatcher.close();

    const jobsRoot = path.join(fixture.queueRoot, "jobs");
    await writeFile(path.join(jobsRoot, "README.invalid"), "isolated sibling");
    await writeFile(path.join(jobsRoot, ".creating-abandoned"), "stale");
    const external = path.join(fixture.root, "external-staging-target");
    await writeFile(external, "must survive cleanup");
    await symlink(external, path.join(jobsRoot, ".deleting-abandoned"));

    const recoveryTasks: Array<() => void> = [];
    const recovered = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      schedule: (task) => recoveryTasks.push(task),
      onBackgroundError: () => undefined,
      runWorkflow: async (input) => await successfulResult(input)
    });
    try {
      await recovered.initialize();
      expect(recoveryTasks).toHaveLength(1);
      expect(await readFile(external, "utf8")).toBe("must survive cleanup");
      recoveryTasks[0]?.();
      await waitForRun(store.ledger, receipt.run_id, "succeeded");
    } finally {
      await recovered.close();
      store.close();
    }
  });
});
