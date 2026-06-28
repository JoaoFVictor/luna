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
    ).toThrow(expect.objectContaining({ code: "workflow_cycle_detected" }));
  });
});
