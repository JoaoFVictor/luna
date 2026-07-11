import { describe, expect, it } from "vitest";
import { analyzeWorkflowGraph } from "../../../src/core/workflow/graph-analysis.js";

describe("workflow graph analysis", () => {
  it("rejects cycles", () => {
    expect(() =>
      analyzeWorkflowGraph({
        nodes: [
          { id: "a", type: "built_in", after: ["b"] },
          { id: "b", type: "built_in", after: ["a"] }
        ]
      })
    ).toThrow(expect.objectContaining({
      code: "workflow_cycle_detected",
      nodeId: "a"
    }));
  });

  it("identifies the authoritative node and edge for an unknown dependency", () => {
    expect(() => analyzeWorkflowGraph({
      nodes: [{ id: "publish", type: "built_in", after: ["missing"] }]
    })).toThrow(expect.objectContaining({
      code: "workflow_reference_unknown",
      nodeId: "publish",
      edge: { from: "missing", to: "publish" },
      path: "$.nodes[0].after[0]"
    }));
  });
});
