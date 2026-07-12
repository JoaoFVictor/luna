import { describe, expect, it, vi } from "vitest";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import {
  createInitialRuntimeState,
  LUNA_RUNTIME_STATE_SCHEMA_VERSION
} from "../../../src/core/runtime/state.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import {
  createNativeWorkflowCompositionExecutor,
  nativeComposedWorkflowRunId
} from "../../../src/platform/native/native-workflow-composition.js";
import {
  runnerAgentRuntime,
  runnerBackends,
  runnerRegistry
} from "../../core/workflow/runner-test-support.js";

function workflow(id: string): WorkflowDefinition {
  return {
    id,
    type: "workflow",
    mode: "read_only",
    directory: `/tmp/${id}`,
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: { type: "object" },
    capabilities: [],
    graph: { nodes: [] },
    revision: `${id}-revision`,
    external_definition_digests: {},
    execution: { max_concurrency: 1 },
    requires: { repository: false },
    observability: { exporters: { runtime_log: { enabled: false, required: false } } },
    subagent_policy: { allow_write: false }
  };
}

describe("native workflow composition executor", () => {
  it("uses a deterministic child identity and does not create a control-plane run", async () => {
    const child = workflow("child");
    const parent = {
      ...workflow("parent"),
      graph: {
        nodes: [{ id: "call", type: "workflow", workflow: "child", input: {} }]
      },
      compositions: { child }
    } satisfies WorkflowDefinition;
    const compiled = compileWorkflow({ workflow: parent, registry: runnerRegistry });
    const parentRun = {
      run_id: "parent-run",
      workflow_id: "parent",
      attempt: 2,
      started_at: "2026-07-12T00:00:00.000Z"
    };
    const runChild = vi.fn(async () => ({
      status: "succeeded" as const,
      output: { ok: true },
      state: createInitialRuntimeState({
        invocation: { value: 1 },
        config: {},
        run: {
          ...parentRun,
          run_id: nativeComposedWorkflowRunId("parent-run", "call", "child"),
          workflow_id: "child"
        },
        workflow: { id: "child", mode: "read_only" }
      })
    }));
    const executor = createNativeWorkflowCompositionExecutor({
      projectRoot: "/project",
      configRoot: "/config",
      runChild
    });

    await expect(executor({
      workflowInput: {
        compiled,
        workflow: parent,
        invocation: {},
        config: {},
        run: parentRun,
        backends: runnerBackends(),
        builtIns: {},
        agentRuntime: runnerAgentRuntime({})
      },
      node: compiled.nodes[0],
      input: { value: 1 },
      child: compiled.nodes[0].composition!
    })).resolves.toEqual({ ok: true });

    expect(runChild).toHaveBeenCalledWith(expect.objectContaining({
      target: { type: "workflow", id: "child" },
      invocation: { value: 1 },
      run: {
        run_id: nativeComposedWorkflowRunId("parent-run", "call", "child"),
        workflow_id: "child",
        attempt: 2,
        started_at: parentRun.started_at
      }
    }));
  });

  it("derives bounded safe identities without direct/nested path collisions", () => {
    const direct = nativeComposedWorkflowRunId(
      "parent-run",
      "a__workflow__b",
      "leaf"
    );
    const nestedParent = nativeComposedWorkflowRunId(
      "parent-run",
      "a",
      "middle"
    );
    const nested = nativeComposedWorkflowRunId(nestedParent, "b", "leaf");

    expect(direct).not.toBe(nested);
    expect(direct).toMatch(/^[a-z0-9._-]+$/);
    expect(direct.length).toBeLessThanOrEqual(128);
  });

  it("validates a recovered terminal checkpoint before reading child state", async () => {
    const child = workflow("child");
    const parent = {
      ...workflow("parent"),
      graph: {
        nodes: [{ id: "call", type: "workflow", workflow: "child", input: {} }]
      },
      compositions: { child }
    } satisfies WorkflowDefinition;
    const compiled = compileWorkflow({ workflow: parent, registry: runnerRegistry });
    const parentRun = {
      run_id: "parent-invalid-recovery",
      workflow_id: "parent",
      attempt: 1,
      started_at: "2026-07-12T00:00:00.000Z"
    };
    const backends = runnerBackends();
    const childRunId = nativeComposedWorkflowRunId(parentRun.run_id, "call", "child");
    await backends.checkpoints.save({
      thread_id: childRunId,
      checkpoint_ns: "",
      checkpoint_id: `terminal-${childRunId}-succeeded`,
      state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
      state: {
        state_schema_version: LUNA_RUNTIME_STATE_SCHEMA_VERSION,
        run_status: "succeeded",
        artifact_refs: [],
        interrupt_refs: []
      },
      metadata: {
        run_status: "succeeded",
        workflow_revision: child.revision
      }
    });
    const runChild = vi.fn();
    const executor = createNativeWorkflowCompositionExecutor({
      projectRoot: "/project",
      configRoot: "/config",
      runChild
    });

    await expect(executor({
      workflowInput: {
        compiled,
        workflow: parent,
        invocation: {},
        config: {},
        run: parentRun,
        backends,
        builtIns: {},
        agentRuntime: runnerAgentRuntime({})
      },
      node: compiled.nodes[0],
      input: { value: 1 },
      child: compiled.nodes[0].composition!
    })).rejects.toMatchObject({ code: "runtime_state_invalid" });
    expect(runChild).not.toHaveBeenCalled();
  });
});
