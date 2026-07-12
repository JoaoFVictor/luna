import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import {
  scopeWorkflowDefinition,
  workflowExecutionScopeBoundaryNodeIds,
  WorkflowExecutionScopeError,
  WorkflowExecutionScopeFixtureError
} from "../../../src/core/workflow/execution-scope.js";

const workflow = {
  graph: { nodes: [
    { id: "start", type: "built_in", uses: "one" },
    { id: "parallel", type: "built_in", uses: "two" },
    { id: "target", type: "built_in", uses: "three", after: ["start"] },
    { id: "later", type: "built_in", uses: "four", after: ["target", "parallel"] },
  ] },
} as WorkflowDefinition;

describe("workflow execution scope", () => {
  it("keeps the selected node and its transitive dependencies only", () => {
    const scoped = scopeWorkflowDefinition(workflow, { kind: "through_node", node_id: "target" });
    expect(scoped.graph.nodes.map((node) => node.id)).toEqual(["start", "target"]);
  });

  it("returns the authoritative definition for a full run", () => {
    expect(scopeWorkflowDefinition(workflow, { kind: "workflow" })).toBe(workflow);
  });

  it("rejects an unknown target", () => {
    expect(() => scopeWorkflowDefinition(workflow, { kind: "through_node", node_id: "missing" }))
      .toThrow(WorkflowExecutionScopeError);
  });

  it("runs one node only when every incoming dependency has saved output", () => {
    const scope = { kind: "isolated_node", node_id: "later" } as const;
    expect(workflowExecutionScopeBoundaryNodeIds(workflow, scope)).toEqual([
      "target",
      "parallel"
    ]);

    const scoped = scopeWorkflowDefinition(
      workflow,
      scope,
      new Set(["target", "parallel"])
    );

    expect(scoped.graph.nodes.map((node) => node.id)).toEqual([
      "parallel",
      "target",
      "later"
    ]);
  });

  it("runs from one node through all descendants with explicit boundary outputs", () => {
    const scope = { kind: "from_node", node_id: "target" } as const;
    expect(workflowExecutionScopeBoundaryNodeIds(workflow, scope)).toEqual([
      "start",
      "parallel"
    ]);

    const scoped = scopeWorkflowDefinition(
      workflow,
      scope,
      new Set(["start", "parallel"])
    );

    expect(scoped.graph.nodes.map((node) => node.id)).toEqual([
      "start",
      "parallel",
      "target",
      "later"
    ]);
  });

  it("rejects scoped execution when a boundary output is missing", () => {
    expect(() => scopeWorkflowDefinition(
      workflow,
      { kind: "from_node", node_id: "target" },
      new Set(["start"])
    )).toThrow(WorkflowExecutionScopeFixtureError);
  });
});
