import { describe, expect, it, vi } from "vitest";
import { createInitialRuntimeState } from "../../../src/core/runtime/state.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import type {
  RunWorkflowInput,
  WorkflowCompositionExecutor
} from "../../../src/core/workflow/execution-contracts.js";
import { executeWorkflowNode } from "../../../src/runtime/workflow/node-executor.js";
import {
  runnerAgentRuntime,
  runnerBackends,
  runnerRegistry
} from "../../core/workflow/runner-test-support.js";

function definition(
  id: string,
  graph: WorkflowDefinition["graph"],
  schemas: { readonly input?: unknown; readonly output?: unknown } = {}
): WorkflowDefinition {
  return {
    id,
    type: "workflow",
    mode: "read_only",
    directory: `/tmp/${id}`,
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: schemas.input ?? { type: "object" },
    output_schema_content: schemas.output ?? { type: "object" },
    capabilities: [],
    graph,
    revision: `${id}-revision`,
    external_definition_digests: {},
    execution: { max_concurrency: 1 },
    requires: { repository: false },
    observability: { exporters: { runtime_log: { enabled: false, required: false } } },
    subagent_policy: { allow_write: false }
  };
}

describe("composed workflow node execution", () => {
  it("passes resolved input to the pinned child and returns its schema-valid output", async () => {
    const child = definition("child", { nodes: [] }, {
      input: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string" } }
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: { message: { type: "string" } }
      }
    });
    const parent = {
      ...definition("parent", {
        nodes: [{
          id: "child_call",
          type: "workflow",
          workflow: "child",
          input: { name: { expression: "$.invocation.name" } }
        }]
      }),
      compositions: { child }
    } satisfies WorkflowDefinition;
    const compiled = compileWorkflow({ workflow: parent, registry: runnerRegistry });
    const compositionExecutor: WorkflowCompositionExecutor = vi.fn(
      async ({ input }) => ({
        message: `Hello ${typeof input === "object" && input !== null && !Array.isArray(input)
          ? input.name
          : ""}`
      })
    );
    const run = {
      run_id: "parent-run",
      workflow_id: parent.id,
      attempt: 1,
      started_at: "2026-07-12T00:00:00.000Z"
    };
    const workflowInput: RunWorkflowInput = {
      compiled,
      workflow: parent,
      invocation: { name: "Luna" },
      config: {},
      run,
      backends: runnerBackends(),
      builtIns: {},
      agentRuntime: runnerAgentRuntime({}),
      compositionExecutor
    };
    const state = createInitialRuntimeState({
      invocation: workflowInput.invocation,
      config: {},
      run,
      workflow: { id: parent.id, mode: parent.mode }
    });

    await expect(executeWorkflowNode(
      workflowInput,
      state,
      { workspaceRoot: "/tmp", agentsRoot: "/tmp" },
      compiled.nodes[0]
    )).resolves.toEqual({ message: "Hello Luna" });
    expect(compositionExecutor).toHaveBeenCalledWith(expect.objectContaining({
      input: { name: "Luna" },
      child: expect.objectContaining({ workflow: child })
    }));
  });

  it("rejects a runtime input that violates the pinned child schema", async () => {
    const child = definition("child", { nodes: [] }, {
      input: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } }
      }
    });
    const parent = {
      ...definition("parent", {
        nodes: [{ id: "child_call", type: "workflow", workflow: "child", input: {} }]
      }),
      compositions: { child }
    } satisfies WorkflowDefinition;
    const compiled = compileWorkflow({ workflow: parent, registry: runnerRegistry });
    const compositionExecutor = vi.fn();
    const run = {
      run_id: "invalid-parent-run",
      workflow_id: parent.id,
      attempt: 1,
      started_at: "2026-07-12T00:00:00.000Z"
    };
    const workflowInput: RunWorkflowInput = {
      compiled,
      workflow: parent,
      invocation: {},
      config: {},
      run,
      backends: runnerBackends(),
      builtIns: {},
      agentRuntime: runnerAgentRuntime({}),
      compositionExecutor
    };
    const state = createInitialRuntimeState({
      invocation: {},
      config: {},
      run,
      workflow: { id: parent.id, mode: parent.mode }
    });

    await expect(executeWorkflowNode(
      workflowInput,
      state,
      { workspaceRoot: "/tmp", agentsRoot: "/tmp" },
      compiled.nodes[0]
    )).rejects.toMatchObject({ code: "runtime_node_output_schema_invalid" });
    expect(compositionExecutor).not.toHaveBeenCalled();
  });
});
