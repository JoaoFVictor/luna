import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { planPrecompletedWorkflowExecution } from "../../../src/core/workflow/precompleted-execution.js";

const workflow = {
  graph: {
    nodes: [
      { id: "shared", type: "built_in", uses: "runtime.noop" },
      { id: "exclusive", type: "built_in", uses: "runtime.noop" },
      {
        id: "supplied",
        type: "built_in",
        uses: "runtime.noop",
        after: ["shared", "exclusive"]
      },
      {
        id: "live",
        type: "built_in",
        uses: "runtime.noop",
        after: ["shared"]
      }
    ]
  }
} as WorkflowDefinition;

describe("precompleted workflow execution plan", () => {
  it("cuts exclusive ancestors, keeps shared ancestors, and clears cut-point dependencies", () => {
    const plan = planPrecompletedWorkflowExecution(
      workflow,
      new Set(["supplied"])
    );

    expect(plan.workflow.graph.nodes.map((node) => node.id)).toEqual([
      "shared",
      "supplied",
      "live"
    ]);
    expect(plan.workflow.graph.nodes.find((node) => node.id === "supplied")?.after)
      .toEqual([]);
    expect([...plan.executable_node_ids]).toEqual(["shared", "live"]);
  });

  it("starts from terminals inside the supplied scope", () => {
    const plan = planPrecompletedWorkflowExecution(
      workflow,
      new Set(["supplied"]),
      new Set(["shared", "exclusive", "supplied"])
    );

    expect(plan.workflow.graph.nodes.map((node) => node.id)).toEqual(["supplied"]);
    expect([...plan.executable_node_ids]).toEqual([]);
  });

  it("accepts independent cutpoints and removes all of their exclusive ancestors", () => {
    const plan = planPrecompletedWorkflowExecution(
      workflow,
      new Set(["live", "supplied"])
    );

    expect(plan.workflow.graph.nodes.map((node) => node.id)).toEqual([
      "supplied",
      "live"
    ]);
    expect([...plan.executable_node_ids]).toEqual([]);
  });

  it("keeps overlapping cutpoints only when separate branches require them", () => {
    const plan = planPrecompletedWorkflowExecution(
      workflow,
      new Set(["shared", "supplied"])
    );

    expect(plan.workflow.graph.nodes.map((node) => node.id)).toEqual([
      "shared",
      "supplied",
      "live"
    ]);
    expect([...plan.executable_node_ids]).toEqual(["live"]);

    const chainOnly = planPrecompletedWorkflowExecution(
      workflow,
      new Set(["shared", "supplied"]),
      new Set(["shared", "exclusive", "supplied"])
    );
    expect(chainOnly.workflow.graph.nodes.map((node) => node.id)).toEqual([
      "supplied"
    ]);
    expect([...chainOnly.executable_node_ids]).toEqual([]);
  });
});
