import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type {
  CheckpointStore,
  RuntimeBackends
} from "../../../src/core/runtime/backends/contracts.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";

export const langGraphInterruptRegistry = createCapabilityRegistry([
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

export const langGraphInterruptWorkflow: WorkflowDefinition = {
  id: "langgraph-wait-authority",
  type: "workflow",
  mode: "read_only",
  directory: "/tmp/langgraph-wait-authority",
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
      },
      {
        id: "after",
        type: "built_in",
        uses: "runtime.after",
        after: ["approve"]
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

export const langGraphPreArtifact = {
  id: "pre.json",
  uri: "memory://pre.json",
  node_id: "pre"
} as const;

export function langGraphInterruptBackends(
  checkpoints: CheckpointStore
): RuntimeBackends {
  return {
    artifacts: createMemoryArtifactManifestStore(),
    events: createMemoryEventStore(),
    interrupts: createMemoryInterruptStore(),
    checkpoints,
    runtimeLogs: createMemoryRuntimeLogStore()
  };
}
