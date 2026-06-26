import { describe, expect, it } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import { runCompiledWorkflow } from "../../../src/core/workflow/runner.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "runtime.step": {
        id: "runtime.step",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_ports: []
      }
    }
  })
]);

const workflow: WorkflowDefinition = {
  id: "streaming-test",
  type: "workflow",
  mode: "read_only",
  directory: "/tmp/streaming-test",
  input_schema: "input.schema.json",
  output_schema: "output.schema.json",
  input_schema_content: { type: "object" },
  output_schema_content: { type: "object" },
  capabilities: ["runtime"],
  graph: {
    nodes: [
      { id: "first", type: "built_in", uses: "runtime.step" },
      { id: "second", type: "built_in", uses: "runtime.step", after: ["first"] }
    ]
  },
  revision: "revision-1",
  external_definition_digests: {},
  execution: { max_concurrency: 1 },
  requires: { repository: false },
  observability: { exporters: { runtime_log: { enabled: true, required: false } } },
  subagent_policy: { allow_write: false }
};

describe("workflow runner event streaming", () => {
  it("emits ordered run and node events", async () => {
    const events = createMemoryEventStore();
    const backends = {
      artifacts: createMemoryArtifactManifestStore(),
      events,
      interrupts: createMemoryInterruptStore(),
      checkpoints: createMemoryCheckpointStore(),
      runtimeLogs: createMemoryRuntimeLogStore()
    };

    await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow, registry }),
      workflow,
      invocation: {},
      config: {},
      run: {
        run_id: "run-events",
        workflow_id: "streaming-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends,
      builtIns: { "runtime.step": async () => ({ ok: true }) },
      agentRuntime: {} as AgentRuntimePort
    });

    expect((await events.list("run-events")).map((event) => event.type)).toEqual([
      "run.started",
      "node.started",
      "node.succeeded",
      "node.started",
      "node.succeeded",
      "run.succeeded"
    ]);
  });
});
