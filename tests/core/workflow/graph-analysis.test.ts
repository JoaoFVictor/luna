import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowGraph,
  type WorkflowGraphAnalysisNode
} from "../../../src/core/workflow/graph-analysis.js";

const nodes: WorkflowGraphAnalysisNode[] = [
  { id: "start", type: "built_in" },
  { id: "approve", type: "built_in", after: ["start"] },
  { id: "implement", type: "built_in" },
  { id: "end", type: "built_in", after: ["approve", "implement"] }
];

describe("workflow graph analysis", () => {
  it("orders a dependency DAG", () => {
    const analysis = analyzeWorkflowGraph({
      nodes
    });

    expect(analysis.topological_node_ids).toEqual([
      "start",
      "approve",
      "implement",
      "end"
    ]);
  });

  it("rejects invalid dependencies and cycles", () => {
    expect(() =>
      analyzeWorkflowGraph({
        nodes: [{ id: "a", type: "built_in", after: ["missing"] }]
      })
    ).toThrow(expect.objectContaining({ code: "workflow_reference_unknown" }));

    expect(() =>
      analyzeWorkflowGraph({
        nodes: [
          { id: "a", type: "built_in", after: ["b"] },
          { id: "b", type: "built_in", after: ["a"] }
        ]
      })
    ).toThrow(expect.objectContaining({ code: "workflow_cycle_detected" }));
  });
});
