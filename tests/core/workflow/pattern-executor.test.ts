import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type { WorkflowDefinition, WorkflowNode } from "../../../src/core/workflow/definition-types.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import { runCompiledWorkflow } from "../../../src/runtime/langgraph/workflow-runner.js";

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "patterns",
    kind: "execution",
    version: "1.0.0",
    patterns: {
      "patterns.echo": {
        id: "patterns.echo",
        declaring_node_type: "pattern",
        input_schema: { type: "object" },
        output_schema: {
          type: "object",
          additionalProperties: false,
          required: ["echoed"],
          properties: { echoed: { type: "boolean" } }
        },
        expand: { type: "declaring_node_subgraph" }
      }
    }
  })
]);

function workflow(nodes: WorkflowNode[]): WorkflowDefinition {
  return {
    id: "pattern-test",
    type: "workflow",
    mode: "read_only",
    directory: "/tmp/pattern-test",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: {
      type: "object",
      additionalProperties: false,
      required: ["echoed"],
      properties: { echoed: { type: "boolean" } }
    },
    capabilities: ["patterns"],
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
      id: "unused-test-agent-runtime",
      display_name: "Unused",
      supported_tool_protocols: [],
      supported_runtime_requirements: []
    }),
    validate: vi.fn(),
    runAgent: vi.fn()
  };
}

describe("workflow pattern executors", () => {
  it("executes pattern nodes through registered pattern executors", async () => {
    const definition = workflow([
      { id: "echo", type: "pattern", uses: "patterns.echo", input: { echoed: true } }
    ]);
    const executePattern = vi.fn(async ({ input }) => input);

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-pattern",
        workflow_id: "pattern-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: backends(),
      builtIns: {},
      patternExecutors: { "patterns.echo": executePattern },
      agentRuntime: agentRuntime()
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected workflow to succeed");
    }
    expect(result.output).toEqual({ echoed: true });
    expect(executePattern).toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({ id: "echo", capability_id: "patterns.echo" }),
        input: { echoed: true }
      })
    );
  });
});
