import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { scopeWorkflowDefinition, WorkflowExecutionScopeError } from "../../../src/core/workflow/execution-scope.js";

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
});
