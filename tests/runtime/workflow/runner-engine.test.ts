import { describe, expect, it } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { WorkflowDefinition, WorkflowNode } from "../../../src/core/workflow/definition-types.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type { RunWorkflowInput } from "../../../src/core/workflow/execution-contracts.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import {
  runCompiledWorkflowWithScheduler,
  type WorkflowNodeScheduler
} from "../../../src/runtime/workflow/runner-engine.js";

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "runtime.noop": {
        id: "runtime.noop",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_ports: []
      }
    }
  })
]);

const workflow = definition([
  { id: "noop", type: "built_in", uses: "runtime.noop" }
]);

function definition(nodes: WorkflowNode[]): WorkflowDefinition {
  return {
    id: "runner-engine-test",
    type: "workflow",
    mode: "read_only",
    directory: "/tmp/runner-engine-test",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: { type: "object" },
    capabilities: ["runtime"],
    graph: { nodes },
    revision: "revision-1",
    external_definition_digests: {},
    execution: { max_concurrency: 1 },
    requires: { repository: false },
    observability: { exporters: { runtime_log: { enabled: true, required: false } } },
    subagent_policy: { allow_write: false }
  };
}

function backends() {
  return {
    artifacts: createMemoryArtifactManifestStore(),
    events: createMemoryEventStore(),
    interrupts: createMemoryInterruptStore(),
    checkpoints: createMemoryCheckpointStore(),
    runtimeLogs: createMemoryRuntimeLogStore()
  };
}

function agentRuntime(): AgentRuntimePort {
  return {
    describe: () => ({
      id: "test-agent-runtime",
      display_name: "Test",
      supported_tool_protocols: [],
      supported_runtime_requirements: []
    }),
    validate: async () => undefined,
    runAgent: async () => ({ output: {} })
  };
}

function runInput({
  runId,
  stores = backends()
}: {
  readonly runId: string;
  readonly stores?: ReturnType<typeof backends>;
}): RunWorkflowInput {
  return {
    compiled: compileWorkflow({ workflow, registry }),
    workflow,
    invocation: {},
    config: {},
    run: {
      run_id: runId,
      workflow_id: workflow.id,
      attempt: 1,
      started_at: "2026-06-25T00:00:00.000Z"
    },
    backends: stores,
    builtIns: {},
    agentRuntime: agentRuntime()
  };
}

describe("runtime-neutral workflow runner engine", () => {
  it("saves a terminal failed checkpoint when the scheduler fails", async () => {
    const stores = backends();
    const input = runInput({
      stores,
      runId: "engine-fails"
    });
    const failingScheduler: WorkflowNodeScheduler<RunWorkflowInput> = async () => {
      throw new Error("scheduler crashed");
    };

    await expect(
      runCompiledWorkflowWithScheduler(input, failingScheduler)
    ).rejects.toThrow("scheduler crashed");

    await expect(stores.checkpoints.load("engine-fails")).resolves.toMatchObject({
      checkpoint_id: "terminal-engine-fails-failed",
      state: { run_status: "failed" }
    });
  });
});
