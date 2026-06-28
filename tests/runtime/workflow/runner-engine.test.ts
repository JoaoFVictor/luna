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
  createRuntimeLogProjectionSink
} from "../../../src/core/observability/sinks.js";
import { createWorkflowObservability } from "../../../src/core/observability/workflow-observability.js";
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

  it("records workflow, node, and built-in spans as the execution source of truth", async () => {
    const stores = backends();
    const observability = createWorkflowObservability({
      run: { id: "engine-trace", workflowId: workflow.id, attempt: 1 },
      sinks: [
        createRuntimeLogProjectionSink({
          runId: "engine-trace",
          store: stores.runtimeLogs
        })
      ],
      idGenerator: (() => {
        let index = 0;
        return () => ["trace-1", "span-workflow", "span-node", "span-built-in"][index++] ?? `span-${index}`;
      })(),
      now: (() => {
        let ms = 0;
        return () => {
          ms += 10;
          return new Date(`2026-06-28T00:00:00.${String(ms).padStart(3, "0")}Z`);
        };
      })()
    });
    const input = {
      ...runInput({ stores, runId: "engine-trace" }),
      observability,
      builtIns: {
        "runtime.noop": async () => ({})
      }
    } satisfies RunWorkflowInput;
    const scheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      input,
      initialState,
      nodes,
      runtimeContext,
      runNode
    }) => {
      const result = await runNode(nodes[0], initialState);
      if (result.kind !== "completed") {
        throw new Error("unexpected wait");
      }
      return {
        kind: "completed",
        state: {
          ...initialState,
          ...result.update
        }
      };
    };

    await runCompiledWorkflowWithScheduler(input, scheduler);

    const ended = observability
      .records()
      .filter((record) => record.type === "span.ended")
      .map((record) => record.span);
    expect(ended.map((span) => span.name)).toEqual([
      "built_in.runtime.noop",
      "node.noop",
      "workflow.run"
    ]);
    expect(ended[0]).toMatchObject({
      trace_id: "trace-1",
      parent_span_id: "span-node",
      kind: "built_in",
      capability_id: "runtime.noop"
    });
    expect(ended[1]).toMatchObject({
      parent_span_id: "span-workflow",
      kind: "node",
      node_id: "noop"
    });
    await expect(stores.runtimeLogs.list("engine-trace")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "span started: workflow.run" }),
        expect.objectContaining({ message: "span ok: workflow.run; duration_ms=80" })
      ])
    );
  });

  it("publishes one final observability summary after the workflow span closes", async () => {
    const stores = backends();
    const observability = createWorkflowObservability({
      run: { id: "engine-summary", workflowId: workflow.id, attempt: 1 },
      sinks: [],
      idGenerator: (() => {
        let index = 0;
        return () => ["trace-summary", "span-workflow", "span-node", "span-built-in"][index++] ?? `span-${index}`;
      })(),
      now: (() => {
        let ms = 0;
        return () => {
          ms += 10;
          return new Date(`2026-06-28T00:00:00.${String(ms).padStart(3, "0")}Z`);
        };
      })()
    });
    const published: unknown[] = [];
    const input = {
      ...runInput({ stores, runId: "engine-summary" }),
      observability,
      artifactPublisher: {
        publish: async ({ node_id, value }: {
          readonly node_id: string;
          readonly value: unknown;
        }) => {
          published.push(value);
          return { id: "summary", uri: "memory://summary", node_id };
        }
      },
      builtIns: {
        "runtime.noop": async () => ({})
      }
    } satisfies RunWorkflowInput;
    const scheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      initialState,
      nodes,
      runNode
    }) => {
      const result = await runNode(nodes[0], initialState);
      if (result.kind !== "completed") {
        throw new Error("unexpected wait");
      }
      return {
        kind: "completed",
        state: {
          ...initialState,
          ...result.update
        }
      };
    };

    await runCompiledWorkflowWithScheduler(input, scheduler);

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      spans: {
        total: 3
      }
    });
  });
});
