import { describe, expect, it } from "vitest";
import {
  workflowExecutionPlanEdges
} from "../../../src/core/workflow/execution-plan.js";
import type { CompiledWorkflow } from "../../../src/core/workflow/compiler.js";

function compiledWorkflow(): CompiledWorkflow {
  const node = (id: string) => ({
    id,
    kind: "built_in" as const,
    yaml_path: `$.nodes.${id}`,
    capability_id: id,
    output_schema: {},
    can_create_pending_interrupt: false,
    source: {
      id,
      type: "built_in" as const,
      uses: id
    }
  });

  return {
    workflow_id: "wf",
    workflow_revision: "rev",
    state_schema_version: "2026-06",
    nodes: [node("a"), node("b"), node("c")],
    edges: [
      { from: "__start__", to: "a" },
      { from: "__start__", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "c" },
      { from: "c", to: "__end__" }
    ],
    state: {
      channels: {
        node_statuses: { reducer: "object_merge" },
        steps: { reducer: "object_merge" },
        attempts: { reducer: "object_merge" },
        artifact_refs: { reducer: "append_only" },
        interrupt_refs: { reducer: "append_only" }
      }
    }
  };
}

describe("workflow execution plan", () => {
  it("serializes ready nodes in the core plan when concurrency policy requires it", () => {
    const compiled = compiledWorkflow();
    const edges = workflowExecutionPlanEdges({
      compiled,
      workflow: {
        id: "wf",
        execution: { max_concurrency: 1 }
      },
      nodes: compiled.nodes,
      startIndex: 0,
      deferredFinalReportIds: new Set(),
      builtInMetadata: () => ({})
    });

    expect(edges).toContainEqual({ from: "a", to: "b" });
    expect(edges).not.toContainEqual({ from: "__start__", to: "a" });
    expect(edges).not.toContainEqual({ from: "c", to: "__end__" });
  });
});
