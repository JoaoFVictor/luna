import { describe, expect, it } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type { WorkflowBuiltInExecutor } from "../../../src/core/workflow/execution-contracts.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import {
  createNativeWorkflowRuntimeRunner
} from "../../../src/runtime/native/workflow-runner.js";

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "runtime.step": {
        id: "runtime.step",
        input_schema: { type: "object" },
        output_schema: {
          type: "object",
          additionalProperties: false,
          required: ["node"],
          properties: { node: { type: "string" } }
        },
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

const workflow: WorkflowDefinition = {
  id: "native-runtime-test",
  type: "workflow",
  mode: "read_only",
  directory: "/tmp/native-runtime-test",
  input_schema: "input.schema.json",
  output_schema: "output.schema.json",
  input_schema_content: { type: "object" },
  output_schema_content: {
    type: "object",
    additionalProperties: false,
    required: ["node"],
    properties: { node: { type: "string" } }
  },
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

const hitlWorkflow: WorkflowDefinition = {
  ...workflow,
  id: "native-runtime-hitl-test",
  capabilities: ["runtime", "approval"],
  graph: {
    nodes: [
      { id: "first", type: "built_in", uses: "runtime.step" },
      { id: "approve", type: "human_gate", uses: "approval.human", after: ["first"] },
      { id: "after", type: "built_in", uses: "runtime.step", after: ["approve"] }
    ]
  }
};

function backends() {
  return {
    artifacts: createMemoryArtifactManifestStore(),
    events: createMemoryEventStore(),
    interrupts: createMemoryInterruptStore(),
    checkpoints: createMemoryCheckpointStore(),
    runtimeLogs: createMemoryRuntimeLogStore()
  };
}

describe("native workflow runtime runner", () => {
  it("runs the neutral workflow engine without LangGraph", async () => {
    const events = createMemoryEventStore();
    const runner = createNativeWorkflowRuntimeRunner();

    const result = await runner.run({
      compiled: compileWorkflow({ workflow, registry }),
      workflow,
      invocation: {},
      config: {},
      run: {
        run_id: "native-runtime-run",
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: {
        ...backends(),
        events
      },
      builtIns: { "runtime.step": async ({ node }) => ({ node: node.id }) },
      agentRuntime: {} as AgentRuntimePort
    });

    expect(result).toMatchObject({
      status: "succeeded",
      output: { node: "second" }
    });
    expect((await events.list("native-runtime-run")).map((event) => event.type)).toEqual([
      "run.started",
      "node.started",
      "node.succeeded",
      "node.started",
      "node.succeeded",
      "run.succeeded"
    ]);
  });

  it("is useful as a runtime contract check by supporting HITL resume, but does not provide LangGraph stream observability", async () => {
    const stores = backends();
    const runner = createNativeWorkflowRuntimeRunner();
    const compiled = compileWorkflow({ workflow: hitlWorkflow, registry });
    const stepBuiltIn: WorkflowBuiltInExecutor = async ({ node }) => ({ node: node.id });
    const builtIns = { "runtime.step": stepBuiltIn };

    const waiting = await runner.run({
      compiled,
      workflow: hitlWorkflow,
      invocation: {},
      config: {},
      run: {
        run_id: "native-runtime-hitl",
        workflow_id: hitlWorkflow.id,
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: stores,
      builtIns,
      agentRuntime: {} as AgentRuntimePort
    });

    expect(waiting).toMatchObject({
      status: "waiting_for_input",
      interrupt_id: "interrupt-native-runtime-hitl-approve",
      checkpoint_id: "checkpoint-native-runtime-hitl-approve"
    });

    const resumed = await runner.resume({
      compiled,
      workflow: hitlWorkflow,
      checkpoint_id: "checkpoint-native-runtime-hitl-approve",
      thread_id: "native-runtime-hitl",
      interrupt_id: "interrupt-native-runtime-hitl-approve",
      decision: { approved: true },
      backends: stores,
      builtIns,
      agentRuntime: {} as AgentRuntimePort
    });

    expect(resumed).toMatchObject({
      status: "succeeded",
      output: { node: "after" }
    });
    await expect(stores.runtimeLogs.list("native-runtime-hitl")).resolves.toEqual([]);
  });
});
