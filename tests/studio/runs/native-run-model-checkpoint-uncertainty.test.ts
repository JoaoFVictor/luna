import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type {
  CheckpointStore,
  RuntimeBackends
} from "../../../src/core/runtime/backends/contracts.js";
import type { JsonValue } from "../../../src/core/runtime/json.js";
import type { WorkflowBuiltInExecutor } from "../../../src/core/workflow/execution-contracts.js";
import { buildNativeWorkflowAgentInputs } from "../../../src/platform/native/native-agent-inputs.js";
import { loadNativeRunContext } from "../../../src/platform/native/native-run-context.js";
import {
  nativeLunaPlatformRegistrations,
  type NativeLunaPlatformRegistrations
} from "../../../src/platform/native/native-platform-registrations.js";
import type { NativeWorkflowRunInput } from "../../../src/runtime/composition/target-executor.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import { runCompiledWorkflow } from "../../../src/runtime/langgraph/workflow-runner.js";
import { NativeStudioRunDispatchQueue } from "../../../src/studio/adapters/filesystem/run-dispatch-queue.js";
import { NativeStudioRunRecoveryJournal } from "../../../src/studio/adapters/filesystem/run-recovery-journal.js";
import { NativeStudioRunTerminalJournal } from "../../../src/studio/adapters/filesystem/run-terminal-journal.js";
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

function checkpointStoreWithUnknownNodeOutput(label: string): CheckpointStore {
  const durable = createMemoryCheckpointStore();
  let uncertainCheckpointId: string | undefined;
  let injectUncertainty = true;
  return {
    ...durable,
    async saveWrites(writes) {
      await durable.saveWrites(writes);
      const nodeOutput = writes.find(
        (write) =>
          write.task_id === "analyze" &&
          write.index === 0 &&
          write.channel === "steps"
      );
      if (nodeOutput !== undefined && injectUncertainty) {
        injectUncertainty = false;
        uncertainCheckpointId = nodeOutput.checkpoint_id;
        throw new Error(`${label} output save response lost`);
      }
    },
    async listWrites(threadId, checkpointNs, checkpointId) {
      if (checkpointId === uncertainCheckpointId) {
        uncertainCheckpointId = undefined;
        throw new Error(`${label} output readback unavailable`);
      }
      return await durable.listWrites(threadId, checkpointNs, checkpointId);
    }
  };
}

function memoryBackends(checkpoints: CheckpointStore): RuntimeBackends {
  return {
    artifacts: createMemoryArtifactManifestStore(),
    events: createMemoryEventStore(),
    interrupts: createMemoryInterruptStore(),
    checkpoints,
    runtimeLogs: createMemoryRuntimeLogStore()
  };
}

async function runNativeWorkflowWithBackends(
  input: NativeWorkflowRunInput,
  options: {
    readonly platform: NativeLunaPlatformRegistrations;
    readonly backends: RuntimeBackends;
    readonly agentRuntime: AgentRuntimePort;
    readonly builtIns?: Record<string, WorkflowBuiltInExecutor>;
  }
) {
  if (input.run === undefined) {
    throw new Error("Studio checkpoint uncertainty requires a preallocated run");
  }
  const context = await loadNativeRunContext(input, {
    platform: options.platform
  });
  await input.onCompiledWorkflow?.(context.nativeWorkflow.compiled);
  const agentInputs = await buildNativeWorkflowAgentInputs({
    workflow: context.nativeWorkflow.workflow,
    agentsRoot: context.agentsRoot,
    configRoot: context.definitionConfigRoot,
    signal: input.signal,
    capabilityRegistry: options.platform.capabilityRegistry
  });
  return await runCompiledWorkflow({
    compiled: context.nativeWorkflow.compiled,
    workflow: context.nativeWorkflow.workflow,
    invocation: input.invocation as JsonValue,
    config: input.workflowConfig ?? {},
    run: input.run,
    signal: input.signal,
    backends: options.backends,
    builtIns: options.builtIns ?? {},
    agentRuntime: options.agentRuntime,
    agentInputs,
    onSucceededState: input.onSucceededState,
    onFailedState: input.onFailedState,
    onLifecycleEvent: input.onLifecycleEvent,
    onLifecycleProjectionError: input.onLifecycleProjectionError
  });
}

describe("native Studio checkpoint uncertainty replay policy", () => {
  it("runs the model once, marks the outcome unknown, and never schedules a replay", async () => {
    const fixture = await writeFixture();
    const { command } = await captureCommand(fixture);
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const backends = memoryBackends(
      checkpointStoreWithUnknownNodeOutput("model")
    );
    const runAgent = vi.fn(async () => ({ output: { reviewed: true } }));
    const agentRuntime: AgentRuntimePort = {
      describe: () => ({
        id: "studio-model-uncertainty-test",
        display_name: "Studio model uncertainty test",
        supported_tool_protocols: ["local"],
        supported_runtime_requirements: ["tool_calling", "mcp_tools"]
      }),
      validate: vi.fn(),
      runAgent
    };
    let runtimeExecutions = 0;
    const runWorkflow = async (input: NativeWorkflowRunInput) => {
      runtimeExecutions += 1;
      return await runNativeWorkflowWithBackends(input, {
        platform: nativeLunaPlatformRegistrations,
        backends,
        agentRuntime
      });
    };
    const scheduled: Array<() => void> = [];
    const backgroundErrors: unknown[] = [];
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME,
      ownerId: "model-uncertainty-owner",
      schedule: (task) => scheduled.push(task),
      onBackgroundError: (cause) => backgroundErrors.push(cause),
      runWorkflow
    });
    let runId: string | undefined;
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      runId = receipt.run_id;
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      const queued = await queue.read(receipt.run_id);
      expect(queued.preallocation.side_effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: "potential",
            category: "model_call",
            retry_semantics: "retry_forbidden",
            node_id: "analyze"
          })
        ])
      );
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        await expect(store.ledger.get(receipt.run_id)).resolves.toMatchObject({
          dispatch_status: "started",
          run_status: "outcome_unknown",
          completeness: "partial",
          failure: { code: "studio_runtime_checkpoint_outcome_unknown" }
        });
        await expect(queue.inspect(receipt.run_id)).resolves.toBe("missing");
      });
      expect(runtimeExecutions).toBe(1);
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(backgroundErrors).toEqual([]);
      const recoveryJournal = new NativeStudioRunRecoveryJournal({
        queueRoot: fixture.queueRoot
      });
      const terminalJournal = new NativeStudioRunTerminalJournal({
        queueRoot: fixture.queueRoot
      });
      await expect(recoveryJournal.read(receipt.run_id)).resolves.toBeUndefined();
      await expect(terminalJournal.read(receipt.run_id)).resolves.toBeUndefined();
    } finally {
      await dispatcher.close();
    }

    if (runId === undefined) {
      store.close();
      throw new Error("Expected the model-backed Studio run to be accepted");
    }
    const recoveryTasks: Array<() => void> = [];
    const recovered = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform: nativeLunaPlatformRegistrations,
      now: () => BASE_TIME + 120_000,
      ownerId: "model-uncertainty-recovery-observer",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => recoveryTasks.push(task),
      runWorkflow: async () => {
        runtimeExecutions += 1;
        throw new Error("An uncertain model call must never replay");
      }
    });
    try {
      await recovered.initialize();
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      await expect(queue.inspect(runId)).resolves.toBe("missing");
      await expect(store.ledger.get(runId)).resolves.toMatchObject({
        run_status: "outcome_unknown",
        failure: { code: "studio_runtime_checkpoint_outcome_unknown" }
      });
      expect(recoveryTasks).toEqual([]);
      expect(runtimeExecutions).toBe(1);
      expect(runAgent).toHaveBeenCalledTimes(1);
    } finally {
      await recovered.close();
      store.close();
    }
  });

  it("does not replay a custom read policy whose explicit retry semantics forbid it", async () => {
    const fixture = await writeFixture();
    const customReadManifest = capabilityManifest({
      id: "custom-read",
      kind: "execution",
      version: "1.0.0",
      built_ins: {
        "custom-read.inspect": {
          id: "custom-read.inspect",
          input_schema: { type: "object" },
          output_schema: { type: "object" },
          required_ports: [],
          side_effect_policy: "custom-read.retry_policy"
        }
      },
      policies: {
        "custom-read.retry_policy": {
          id: "custom-read.retry_policy",
          config_schema: {
            type: "object",
            additionalProperties: false,
            required: ["operation_id"],
            properties: {
              operation_id: {
                const: "custom-read.operation.inspect"
              }
            }
          },
          side_effect_semantics: "read",
          side_effect_category: "other",
          side_effect_operation_ids: ["custom-read.operation.inspect"],
          retry_semantics: "retry_forbidden",
          idempotency_scope: "attempt"
        }
      }
    });
    const capabilityManifests = [
      ...nativeLunaPlatformRegistrations.capabilityManifests,
      customReadManifest
    ];
    const platform: NativeLunaPlatformRegistrations = {
      ...nativeLunaPlatformRegistrations,
      capabilityManifests,
      capabilityRegistry: createCapabilityRegistry(capabilityManifests)
    };
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
      "  - custom-read",
      "requires:",
      "  repository: false",
      "execution:",
      "  max_concurrency: 1",
      "nodes:",
      "  - id: analyze",
      "    type: built_in",
      "    uses: custom-read.inspect",
      "    policies:",
      "      - uses: custom-read.retry_policy",
      "        config:",
      "          operation_id: custom-read.operation.inspect",
      "    input: {}",
      ""
    ].join("\n"));
    const { command } = await captureCommand(fixture, { platform });
    const store = await createSqliteRunStore({ filePath: fixture.databasePath });
    const backends = memoryBackends(
      checkpointStoreWithUnknownNodeOutput("custom read")
    );
    const unexpectedAgentCall = vi.fn(async () => {
      throw new Error("The custom built-in workflow must not invoke an agent");
    });
    const agentRuntime: AgentRuntimePort = {
      describe: () => ({
        id: "studio-custom-read-test",
        display_name: "Studio custom read test",
        supported_tool_protocols: ["local"],
        supported_runtime_requirements: []
      }),
      validate: vi.fn(),
      runAgent: unexpectedAgentCall
    };
    const executeRead = vi.fn(async () => ({ inspected: true }));
    let runtimeExecutions = 0;
    const runWorkflow = async (input: NativeWorkflowRunInput) => {
      runtimeExecutions += 1;
      return await runNativeWorkflowWithBackends(input, {
        platform,
        backends,
        agentRuntime,
        builtIns: { "custom-read.inspect": executeRead }
      });
    };
    const scheduled: Array<() => void> = [];
    const backgroundErrors: unknown[] = [];
    const dispatcher = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform,
      now: () => BASE_TIME,
      ownerId: "custom-read-uncertainty-owner",
      schedule: (task) => scheduled.push(task),
      onBackgroundError: (cause) => backgroundErrors.push(cause),
      runWorkflow
    });
    let runId: string | undefined;
    try {
      await dispatcher.initialize();
      const receipt = await dispatcher.dispatch(command);
      runId = receipt.run_id;
      const queue = new NativeStudioRunDispatchQueue({ root: fixture.queueRoot });
      const queued = await queue.read(receipt.run_id);
      expect(queued.preallocation.side_effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: "potential",
            category: "other",
            retry_semantics: "retry_forbidden",
            idempotency_scope: "attempt",
            operation_id: "custom-read.operation.inspect",
            node_id: "analyze"
          }),
          expect.objectContaining({
            stage: "resolved",
            category: "other",
            retry_semantics: "retry_forbidden",
            idempotency_scope: "attempt",
            operation_id: "custom-read.operation.inspect",
            node_id: "analyze"
          })
        ])
      );
      scheduled.splice(0).forEach((task) => task());
      await vi.waitFor(async () => {
        await expect(store.ledger.get(receipt.run_id)).resolves.toMatchObject({
          dispatch_status: "started",
          owner_id: "custom-read-uncertainty-owner",
          run_status: "outcome_unknown",
          completeness: "partial",
          failure: { code: "studio_runtime_checkpoint_outcome_unknown" }
        });
        await expect(queue.inspect(receipt.run_id)).resolves.toBe("missing");
      });
      expect(runtimeExecutions).toBe(1);
      expect(executeRead).toHaveBeenCalledTimes(1);
      expect(unexpectedAgentCall).not.toHaveBeenCalled();
      expect(backgroundErrors).toEqual([]);
      const recoveryJournal = new NativeStudioRunRecoveryJournal({
        queueRoot: fixture.queueRoot
      });
      await expect(recoveryJournal.read(receipt.run_id)).resolves.toBeUndefined();
    } finally {
      await dispatcher.close();
    }

    if (runId === undefined) {
      store.close();
      throw new Error("Expected the custom-read Studio run to be accepted");
    }
    const recoveryTasks: Array<() => void> = [];
    const recovered = new NativeStudioRunDispatcher({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      queueRoot: fixture.queueRoot,
      ledger: store.ledger,
      platform,
      now: () => BASE_TIME + 120_000,
      ownerId: "custom-read-recovery-observer",
      heartbeatIntervalMs: 1_000,
      orphanThresholdMs: 3_000,
      schedule: (task) => recoveryTasks.push(task),
      runWorkflow: async () => {
        runtimeExecutions += 1;
        throw new Error("A retry-forbidden custom read must never replay");
      }
    });
    try {
      await recovered.initialize();
      await expect(store.ledger.get(runId)).resolves.toMatchObject({
        owner_id: "custom-read-uncertainty-owner",
        run_status: "outcome_unknown",
        failure: { code: "studio_runtime_checkpoint_outcome_unknown" }
      });
      expect(recoveryTasks).toEqual([]);
      expect(runtimeExecutions).toBe(1);
      expect(executeRead).toHaveBeenCalledTimes(1);
    } finally {
      await recovered.close();
      store.close();
    }
  });
});
