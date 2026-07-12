import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import type { CheckpointStore } from "../../../src/core/runtime/backends/contracts.js";
import { RuntimeDurabilityRecoveryRequiredError } from "../../../src/core/runtime/errors.js";
import type { JsonValue } from "../../../src/core/runtime/json.js";
import { loadNativeRunContext } from "../../../src/platform/native/native-run-context.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import { runCompiledWorkflow } from "../../../src/runtime/langgraph/workflow-runner.js";
import { NativeStudioRunDispatchQueue } from "../../../src/studio/adapters/filesystem/run-dispatch-queue.js";
import { NativeStudioRunRecoveryJournal } from "../../../src/studio/adapters/filesystem/run-recovery-journal.js";
import { NativeStudioRunDispatcher } from "../../../src/studio/adapters/native/run-dispatcher.js";
import { createSqliteRunStore } from "../../../src/studio/adapters/sqlite/run-store.js";
import {
  BASE_TIME,
  captureCommand,
  cleanupNativeLaunchFixtures,
  writeFixture
} from "./native-run-launch-test-support.js";

afterEach(async () => {
  await cleanupNativeLaunchFixtures();
});

describe("native Studio exact node recovery", () => {
  it("retries a transient persisted-node read without failing or re-executing the node", async () => {
    const fixture = await writeFixture();
    await writeFile(fixture.workflowPath, [
      "id: pinned-workflow",
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "config:",
      "  file: pinned-workflow.yaml",
      "  schema: config.schema.json",
      "capabilities:",
      "  - findings",
      "requires:",
      "  repository: false",
      "execution:",
      "  max_concurrency: 1",
      "nodes:",
      "  - id: analyze",
      "    type: built_in",
      "    uses: findings.merge",
      "    input:",
      "      sources:",
      "        - id: fixture",
      "          result:",
      "            findings: []",
      "            reviewed_ranges: []",
      ""
    ].join("\n"));
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const durableCheckpoints = createMemoryCheckpointStore();
    let rejectNextNodeRecoveryRead = false;
    const checkpoints: CheckpointStore = {
      ...durableCheckpoints,
      async listWrites(threadId, checkpointNs, checkpointId) {
        if (
          rejectNextNodeRecoveryRead &&
          checkpointId.includes("-analyze")
        ) {
          rejectNextNodeRecoveryRead = false;
          throw new Error("persisted node ledger transiently unavailable");
        }
        return await durableCheckpoints.listWrites(
          threadId,
          checkpointNs,
          checkpointId
        );
      }
    };
    const backends = {
      artifacts: createMemoryArtifactManifestStore(),
      events: createMemoryEventStore(),
      interrupts: createMemoryInterruptStore(),
      checkpoints,
      runtimeLogs: createMemoryRuntimeLogStore()
    };
    const executeBuiltIn = vi.fn(async () => ({
      summary: "",
      findings: [],
      reviewed_ranges: []
    }));
    const firstBarrierFailure = new RuntimeDurabilityRecoveryRequiredError(
      "simulated control-plane barrier recovery"
    );
    let runtimeCalls = 0;
    const runWorkflow = async (
      input: Parameters<typeof loadNativeRunContext>[0]
    ) => {
      if (input.run === undefined) {
        throw new Error("Studio node recovery requires its preallocated run");
      }
      runtimeCalls += 1;
      const context = await loadNativeRunContext(input, {
        platform: nativeLunaPlatformRegistrations
      });
      await input.onCompiledWorkflow?.(context.nativeWorkflow.compiled);
      return await runCompiledWorkflow({
        compiled: context.nativeWorkflow.compiled,
        workflow: context.nativeWorkflow.workflow,
        invocation: input.invocation as JsonValue,
        config: input.workflowConfig ?? {},
        run: input.run,
        signal: input.signal,
        backends,
        builtIns: { "findings.merge": executeBuiltIn },
        agentRuntime: {} as AgentRuntimePort,
        onSucceededState: runtimeCalls === 1
          ? async () => {
              throw firstBarrierFailure;
            }
          : input.onSucceededState,
        onFailedState: input.onFailedState,
        onLifecycleEvent: input.onLifecycleEvent,
        onLifecycleProjectionError: input.onLifecycleProjectionError
      });
    };
    const scheduled: Array<() => void> = [];
    const firstErrors: unknown[] = [];
    const first = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "node-recovery-first-owner",
      schedule: (task) => scheduled.push(task),
      onBackgroundError: (cause) => firstErrors.push(cause),
      runWorkflow
    });
    let runId: string | undefined;
    try {
      await first.initialize();
      const receipt = await first.dispatch(command);
      runId = receipt.run_id;
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(() => expect(firstErrors).toEqual([
        firstBarrierFailure
      ]));
      expect(executeBuiltIn).toHaveBeenCalledTimes(1);
      await expect(store.ledger.get(receipt.run_id)).resolves.toMatchObject({
        dispatch_status: "started",
        run_status: "running"
      });
      const recoveryJournal = new NativeStudioRunRecoveryJournal({
        queueRoot: fixture.queueRoot
      });
      await expect(recoveryJournal.read(receipt.run_id)).resolves.toMatchObject({
        run_id: receipt.run_id,
        reason: "runtime_durability_recovery_required"
      });
    } finally {
      await first.close();
    }

    if (runId === undefined) {
      store.close();
      throw new Error("Expected the Studio run to be accepted");
    }
    rejectNextNodeRecoveryRead = true;
    const retained = await store.ledger.get(runId);
    const secondNow = Date.parse(retained?.heartbeat_at ?? "") + 120_000;
    const secondTasks: Array<() => void> = [];
    const secondErrors: unknown[] = [];
    const second = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => secondNow,
      ownerId: "node-recovery-transient-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => secondTasks.push(task),
      onBackgroundError: (cause) => secondErrors.push(cause),
      runWorkflow
    });
    try {
      await second.initialize();
      expect(secondTasks).toHaveLength(1);
      secondTasks.splice(0).forEach((task) => task());
      await vi.waitFor(() => {
        expect(secondErrors[0]).toMatchObject({
          code: "runtime_durability_recovery_required",
          details: { operation: "load_persisted_node_recovery" }
        });
      });
      expect(executeBuiltIn).toHaveBeenCalledTimes(1);
      const stillRecoverable = await store.ledger.get(runId);
      expect(stillRecoverable).toMatchObject({
        dispatch_status: "started",
        run_status: "running"
      });
      expect(stillRecoverable).not.toHaveProperty("failure");
      const queue = new NativeStudioRunDispatchQueue({
        root: fixture.queueRoot
      });
      await expect(queue.inspect(runId)).resolves.toBe("present");
    } finally {
      await second.close();
    }

    const afterTransient = await store.ledger.get(runId);
    const thirdNow = Date.parse(afterTransient?.heartbeat_at ?? "") + 120_000;
    const thirdTasks: Array<() => void> = [];
    const thirdErrors: unknown[] = [];
    const third = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => thirdNow,
      ownerId: "node-recovery-final-owner",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => thirdTasks.push(task),
      onBackgroundError: (cause) => thirdErrors.push(cause),
      runWorkflow
    });
    try {
      await third.initialize();
      expect(thirdTasks).toHaveLength(1);
      thirdTasks.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        if (thirdErrors[0] !== undefined) {
          throw thirdErrors[0];
        }
        await expect(store.ledger.get(runId)).resolves.toMatchObject({
          dispatch_status: "started",
          run_status: "succeeded",
          completeness: "complete",
          owner_id: "node-recovery-final-owner"
        });
      });
      expect(executeBuiltIn).toHaveBeenCalledTimes(1);
      expect(runtimeCalls).toBe(3);
      expect(thirdErrors).toEqual([]);
      const queue = new NativeStudioRunDispatchQueue({
        root: fixture.queueRoot
      });
      await expect(queue.inspect(runId)).resolves.toBe("missing");
    } finally {
      await third.close();
      store.close();
    }
  });
});
