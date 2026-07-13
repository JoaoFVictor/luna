import type {
  CheckpointStore,
  RuntimeBackends
} from "../../../src/core/runtime/backends/contracts.js";
import type { InterruptStore } from "../../../src/core/runtime/interrupts/contracts.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";

export const WAIT_INTENT_CHANNEL = "interrupt_wait_intent";

export const interruptWaitRecoveryRegistry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "runtime.pre": {
        id: "runtime.pre",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_ports: []
      },
      "runtime.after": {
        id: "runtime.after",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_ports: []
      }
    }
  }),
  capabilityManifest({
    id: "approval",
    kind: "execution",
    version: "1.0.0",
    gates: {
      "approval.human": {
        id: "approval.human",
        input_schema: { type: "object" },
        decision_schema: { type: "object" },
        output_schema: {
          type: "object",
          additionalProperties: false,
          required: ["approved"],
          properties: { approved: { type: "boolean" } }
        },
        interrupt: "required"
      }
    }
  })
]);

export const interruptWaitRecoveryWorkflow: WorkflowDefinition = {
  id: "interrupt-wait-recovery",
  type: "workflow",
  mode: "read_only",
  directory: "/tmp/interrupt-wait-recovery",
  input_schema: "input.schema.json",
  output_schema: "output.schema.json",
  input_schema_content: { type: "object" },
  output_schema_content: { type: "object" },
  capabilities: ["runtime", "approval"],
  graph: {
    nodes: [
      { id: "pre", type: "built_in", uses: "runtime.pre" },
      {
        id: "approve",
        type: "human_gate",
        uses: "approval.human",
        after: ["pre"]
      }
    ]
  },
  revision: "revision-1",
  external_definition_digests: {},
  execution: { max_concurrency: 1 },
  requires: { repository: false },
  observability: {
    exporters: { runtime_log: { enabled: true, required: false } }
  },
  subagent_policy: { allow_write: false }
};

export type FaultStage =
  | "none"
  | "intent_write"
  | "waiting_checkpoint"
  | "interrupt_create";

export type FaultedWaitBackends = {
  readonly backends: RuntimeBackends;
  readonly durableCheckpoints: CheckpointStore;
  readonly durableInterrupts: InterruptStore;
  failNextWaitIntentRead(): void;
};

export function createFaultedWaitBackends(
  stage: FaultStage,
  waitingCheckpointId: string
): FaultedWaitBackends {
  const durableCheckpoints = createMemoryCheckpointStore();
  const durableInterrupts = createMemoryInterruptStore();
  let injected = false;
  let rejectCheckpointReadback = false;
  let rejectInterruptReadback = false;
  let rejectNextWaitIntentRead = false;

  const checkpoints: CheckpointStore = {
    ...durableCheckpoints,
    async save(input) {
      const saved = await durableCheckpoints.save(input);
      if (
        stage === "waiting_checkpoint" &&
        !injected &&
        input.checkpoint_id === waitingCheckpointId
      ) {
        injected = true;
        rejectCheckpointReadback = true;
        throw new Error("waiting checkpoint response lost after commit");
      }
      return saved;
    },
    async load(threadId, options) {
      if (
        rejectCheckpointReadback &&
        options?.checkpointId === waitingCheckpointId
      ) {
        rejectCheckpointReadback = false;
        throw new Error("waiting checkpoint readback unavailable");
      }
      return await durableCheckpoints.load(threadId, options);
    },
    async saveWrites(writes) {
      await durableCheckpoints.saveWrites(writes);
      if (
        stage === "intent_write" &&
        !injected &&
        writes.some((write) => write.channel === WAIT_INTENT_CHANNEL)
      ) {
        injected = true;
        rejectCheckpointReadback = true;
        throw new Error("wait intent response lost after commit");
      }
    },
    async listWrites(threadId, checkpointNs, checkpointId) {
      if (
        rejectNextWaitIntentRead &&
        checkpointId === waitingCheckpointId
      ) {
        rejectNextWaitIntentRead = false;
        throw new Error("wait intent read transiently unavailable");
      }
      if (rejectCheckpointReadback && checkpointId === waitingCheckpointId) {
        rejectCheckpointReadback = false;
        throw new Error("wait intent readback unavailable");
      }
      return await durableCheckpoints.listWrites(
        threadId,
        checkpointNs,
        checkpointId
      );
    }
  };

  const interrupts: InterruptStore = {
    ...durableInterrupts,
    async create(record) {
      await durableInterrupts.create(record);
      if (stage === "interrupt_create" && !injected) {
        injected = true;
        rejectInterruptReadback = true;
        throw new Error("interrupt response lost after commit");
      }
    },
    async get(id) {
      if (rejectInterruptReadback) {
        rejectInterruptReadback = false;
        throw new Error("interrupt readback unavailable");
      }
      return await durableInterrupts.get(id);
    }
  };

  return {
    durableCheckpoints,
    durableInterrupts,
    failNextWaitIntentRead() {
      rejectNextWaitIntentRead = true;
    },
    backends: {
      artifacts: createMemoryArtifactManifestStore(),
      events: createMemoryEventStore(),
      interrupts,
      checkpoints,
      runtimeLogs: createMemoryRuntimeLogStore()
    }
  };
}
