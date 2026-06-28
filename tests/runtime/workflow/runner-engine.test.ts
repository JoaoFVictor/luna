import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { JsonValue } from "../../../src/core/runtime/json.js";
import type { LunaRuntimeState } from "../../../src/core/runtime/state.js";
import type { WorkflowDefinition, WorkflowNode } from "../../../src/core/workflow/definition-types.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type {
  RunWorkflowInput,
  WorkflowBuiltInExecutor
} from "../../../src/core/workflow/execution-contracts.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import {
  runCompiledWorkflowWithScheduler,
  resumeCompiledWorkflowWithScheduler,
  type WorkflowNodeScheduler
} from "../../../src/runtime/workflow/runner-engine.js";
import type { WorkflowNodeRunUpdate } from "../../../src/runtime/workflow/node-runner.js";

const registry = createCapabilityRegistry([
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

const workflow = definition([
  { id: "pre", type: "built_in", uses: "runtime.pre" },
  { id: "approve", type: "human_gate", uses: "approval.human", after: ["pre"] },
  { id: "after", type: "built_in", uses: "runtime.after", after: ["approve"] }
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
    capabilities: ["runtime", "approval"],
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
  builtIns,
  runId,
  stores = backends()
}: {
  readonly builtIns: Record<string, WorkflowBuiltInExecutor>;
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
    builtIns,
    agentRuntime: agentRuntime()
  };
}

const sequentialScheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
  initialState,
  nodes,
  runNode
}) => {
  let state = initialState;
  for (const node of nodes) {
    const result = await runNode(node, state);
    if (result.kind === "waiting_for_input") {
      return result;
    }

    state = applyNodeUpdate(state, result.update);
  }

  return { kind: "completed", state };
};

function applyNodeUpdate(
  state: LunaRuntimeState,
  update: WorkflowNodeRunUpdate
): LunaRuntimeState {
  return {
    ...state,
    node_statuses: { ...state.node_statuses, ...update.node_statuses },
    attempts: { ...state.attempts, ...update.attempts },
    steps: { ...state.steps, ...update.steps },
    artifact_refs: [
      ...state.artifact_refs,
      ...(update.artifact_refs ?? [])
    ]
  };
}

function stepObject(
  steps: Readonly<Record<string, JsonValue>>,
  id: string
): Readonly<Record<string, JsonValue>> {
  const value = steps[id];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected step ${id} to be an object`);
  }

  return value;
}

describe("runtime-neutral workflow runner engine", () => {
  it("executes a workflow through an injected scheduler without LangGraph", async () => {
    const builtIns = {
      "runtime.pre": vi.fn(async () => ({ before: true })),
      "runtime.after": vi.fn(async () => ({ done: true }))
    };

    const result = await runCompiledWorkflowWithScheduler(
      runInput({ builtIns, runId: "engine-run" }),
      sequentialScheduler
    );

    expect(result).toMatchObject({
      status: "waiting_for_input",
      interrupt_id: "interrupt-engine-run-approve",
      checkpoint_id: "checkpoint-engine-run-approve"
    });
    expect(builtIns["runtime.pre"]).toHaveBeenCalledTimes(1);
    expect(builtIns["runtime.after"]).not.toHaveBeenCalled();
  });

  it("resumes from checkpoint and continues downstream through the same neutral scheduler", async () => {
    const stores = backends();
    const builtIns = {
      "runtime.pre": vi.fn(async () => ({ before: true })),
      "runtime.after": vi.fn(async ({ state }) => ({
        before: stepObject(state.steps, "pre").before,
        approved: stepObject(state.steps, "approve").approved
      }))
    };
    const input = runInput({ builtIns, runId: "engine-resume", stores });
    const waiting = await runCompiledWorkflowWithScheduler(input, sequentialScheduler);
    if (waiting.status !== "waiting_for_input") {
      throw new Error("expected waiting_for_input");
    }

    const resumed = await resumeCompiledWorkflowWithScheduler(
      {
        ...input,
        thread_id: "engine-resume",
        checkpoint_id: waiting.checkpoint_id,
        interrupt_id: waiting.interrupt_id,
        decision: { approved: true }
      },
      sequentialScheduler
    );

    expect(resumed).toMatchObject({
      status: "succeeded",
      output: { before: true, approved: true }
    });
    await expect(stores.checkpoints.listWrites(
      "engine-resume",
      "",
      "checkpoint-engine-resume-approve"
    )).resolves.toContainEqual(expect.objectContaining({
      task_id: "approve",
      channel: "steps",
      value: { approved: true }
    }));
  });

  it("saves a terminal failed checkpoint when the scheduler fails after a partial state update", async () => {
    const stores = backends();
    const input = runInput({
      stores,
      runId: "engine-fails",
      builtIns: {
        "runtime.pre": async () => ({ before: true }),
        "runtime.after": async () => ({ done: true })
      }
    });
    const failingScheduler: WorkflowNodeScheduler<RunWorkflowInput> = async ({
      initialState,
      nodes,
      runNode
    }) => {
      const first = await runNode(nodes[0], initialState);
      if (first.kind === "waiting_for_input") {
        return first;
      }
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
