import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { createObservabilitySummary } from "../../../src/core/observability/summary.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type {
  WorkflowDefinition,
  WorkflowNode
} from "../../../src/core/workflow/definition-types.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import {
  runCompiledWorkflow,
  type WorkflowAgentDefaults
} from "../../../src/runtime/langgraph/workflow-runner.js";

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "runtime",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "runtime.ok": {
        id: "runtime.ok",
        input_schema: { type: "object" },
        output_schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } }
        },
        required_ports: []
      }
    }
  }),
  capabilityManifest({
    id: "agents",
    kind: "execution",
    version: "1.0.0",
    schemas: {
      "agents.output": {
        id: "agents.output",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["reviewed"],
          properties: { reviewed: { type: "boolean" } }
        }
      }
    }
  })
]);

const okOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } }
};

function workflow(nodes: WorkflowNode[], outputSchema: unknown = okOutputSchema): WorkflowDefinition {
  return {
    id: "runner-test",
    type: "workflow",
    mode: "read_only",
    directory: "/tmp/runner-test",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: outputSchema,
    capabilities: ["runtime", "agents"],
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
      supported_tool_protocols: ["local"],
      supported_runtime_requirements: ["tool_calling", "mcp_tools"]
    }),
    validate: vi.fn(),
    runAgent: vi.fn()
  };
}

const agentDefaults: WorkflowAgentDefaults = {
  instructions: "Review the workflow output.",
  model_profile: { model: "openai/gpt-5", reasoning_effort: "medium" },
  tools: { tools: [], runtime_requirements: [] },
  context: { repository: "luna" },
  cwd: "/tmp/runner-test"
};

function agentRuntimeResult(result: Awaited<ReturnType<AgentRuntimePort["runAgent"]>>): AgentRuntimePort {
  return {
    describe: () => ({
      id: "test-agent-runtime",
      display_name: "Test",
      supported_tool_protocols: ["local"],
      supported_runtime_requirements: ["tool_calling", "mcp_tools"]
    }),
    validate: vi.fn(),
    runAgent: vi.fn(async () => result)
  };
}

describe("LangGraph workflow runner artifacts", () => {
  it("publishes declared node artifacts after successful node output", async () => {
    const definition = workflow([
      {
        id: "report",
        type: "built_in",
        uses: "runtime.ok",
        artifacts: [
          {
            path: "report.json",
            publisher: "artifacts.manifest_publisher",
            source: { expression: "$.steps.report" },
            format: "json",
            required: true
          }
        ]
      }
    ]);
    const published: unknown[] = [];
    const runtimeBackends = backends();
    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-artifacts",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: runtimeBackends,
      builtIns: { "runtime.ok": async () => ({ ok: true }) },
      agentRuntime: agentRuntime(),
      artifactPublisher: {
        async publish(input) {
          published.push(input);
          return {
            id: input.path,
            uri: `artifact://run-artifacts/${input.path}`,
            node_id: input.node_id,
            media_type: "application/json"
          };
        }
      }
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      return;
    }
    expect(published).toEqual([
      expect.objectContaining({
        node_id: "report",
        path: "report.json",
        format: "json",
        value: { ok: true }
      })
    ]);
    expect(result.state.artifact_refs).toEqual([
      {
        id: "report.json",
        uri: "artifact://run-artifacts/report.json",
        node_id: "report"
      }
    ]);
  });

  it("publishes the workflow observability summary after observed agent calls", async () => {
    const summary = createObservabilitySummary({
      runId: "run-observed-agent",
      workflowId: "runner-test"
    });
    const runtime = agentRuntimeResult({
      output: { reviewed: true },
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        cache_read_tokens: 3,
        cache_write_tokens: 2,
        cost: {
          input: 0.1,
          output: 0.2,
          cache_read: 0.03,
          cache_write: 0.04,
          total: 0.37
        }
      },
      runtime_metadata: {
        provider: "test-provider",
        model: "test-model"
      }
    });
    const published: unknown[] = [];
    const definition = workflow(
      [
        {
          id: "review",
          type: "agent",
          agent: "reviewer",
          output_schema: "agents.output"
        }
      ],
      {
        type: "object",
        additionalProperties: false,
        required: ["reviewed"],
        properties: { reviewed: { type: "boolean" } }
      }
    );
    const runtimeBackends = backends();

    const result = await runCompiledWorkflow({
      compiled: compileWorkflow({ workflow: definition, registry }),
      workflow: definition,
      invocation: {},
      config: {},
      run: {
        run_id: "run-observed-agent",
        workflow_id: "runner-test",
        attempt: 1,
        started_at: "2026-06-25T00:00:00.000Z"
      },
      backends: runtimeBackends,
      builtIns: {},
      agentRuntime: runtime,
      observabilitySummary: summary,
      artifactPublisher: {
        async publish(input) {
          published.push(input);
          return {
            id: input.path,
            uri: `artifact://run-artifacts/${input.path}`,
            node_id: input.node_id,
            media_type: "application/json"
          };
        }
      },
      agentInputs: { review: agentDefaults }
    });

    expect(result.status).toBe("succeeded");
    expect(summary).toMatchObject({
      prompt_operations: 1,
      usage_missing_count: 0,
      tokens: {
        input: 11,
        output: 7,
        cache_read: 3,
        cache_write: 2,
        total: 18
      },
      cost: {
        input: 0.1,
        output: 0.2,
        cache_read: 0.03,
        cache_write: 0.04,
        total: 0.37
      }
    });
    expect(published).toContainEqual(
      expect.objectContaining({
        node_id: "observability",
        path: "observability-summary.json",
        format: "json",
        overwrite_policy: "replace",
        value: expect.objectContaining({
          run_id: "run-observed-agent",
          prompt_operations: 1
        })
      })
    );
    await expect(runtimeBackends.events.list("run-observed-agent")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent_call.started",
          node_id: "review",
          data: expect.objectContaining({
            agent_id: "reviewer",
            model_profile: "openai/gpt-5",
            runtime_id: "test-agent-runtime"
          })
        }),
        expect.objectContaining({
          type: "agent_call.succeeded",
          node_id: "review",
          data: expect.objectContaining({
            agent_id: "reviewer",
            duration_ms: expect.any(Number),
            tokens: expect.objectContaining({
              input: 11,
              output: 7,
              total: 18
            }),
            cost: expect.objectContaining({
              total: 0.37
            }),
            runtime_metadata: expect.objectContaining({
              provider: "test-provider",
              model: "test-model"
            })
          })
        })
      ])
    );
  });
});
