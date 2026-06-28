import { describe, expect, it } from "vitest";
import {
  workflowExecutionPlanEdges
} from "../../../src/core/workflow/execution-plan.js";
import type {
  CompiledWorkflow,
  CompiledWorkflowNode
} from "../../../src/core/workflow/compiler.js";

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

function compiledPatternWorkflow(
  nodes: readonly CompiledWorkflowNode[]
): CompiledWorkflow {
  return {
    workflow_id: "wf",
    workflow_revision: "rev",
    state_schema_version: "2026-06",
    nodes: [...nodes],
    edges: [
      { from: "__start__", to: nodes[0].id },
      { from: "__start__", to: nodes[1].id },
      { from: nodes[0].id, to: "__end__" },
      { from: nodes[1].id, to: "__end__" }
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

function patternNode(
  id: string,
  executionPolicy?: CompiledWorkflowNode["execution_policy"]
): CompiledWorkflowNode {
  return {
    id,
    kind: "pattern",
    yaml_path: `$.nodes.${id}`,
    capability_id: `patterns.${id}`,
    output_schema: {},
    can_create_pending_interrupt: false,
    ...(executionPolicy === undefined
      ? {}
      : { execution_policy: executionPolicy }),
    source: {
      id,
      type: "pattern",
      uses: `patterns.${id}`
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
  });

  it("does not treat every pattern as a gated agent loop", () => {
    const compiled = compiledPatternWorkflow([
      patternNode("a"),
      patternNode("b")
    ]);

    const edges = workflowExecutionPlanEdges({
      compiled,
      workflow: {
        id: "wf",
        execution: { max_concurrency: 2 }
      },
      nodes: compiled.nodes,
      startIndex: 0,
      deferredFinalReportIds: new Set(),
      builtInMetadata: () => ({})
    });

    expect(edges).not.toContainEqual({ from: "a", to: "b" });
  });

  it("derives pattern scheduling from compiled registration metadata", () => {
    const compiled = compiledPatternWorkflow([
      patternNode("a", { batch_exclusion_keys: ["pattern_session"] }),
      patternNode("b", { batch_exclusion_keys: ["pattern_session"] })
    ]);

    const edges = workflowExecutionPlanEdges({
      compiled,
      workflow: {
        id: "wf",
        execution: { max_concurrency: 2 }
      },
      nodes: compiled.nodes,
      startIndex: 0,
      deferredFinalReportIds: new Set(),
      builtInMetadata: () => ({})
    });

    expect(edges).toContainEqual({ from: "a", to: "b" });
  });
});
