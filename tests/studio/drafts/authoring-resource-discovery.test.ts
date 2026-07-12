import { describe, expect, it } from "vitest";
import {
  discoverStudioAgentResources,
  discoverStudioWorkflowResources
} from "../../../src/studio/application/drafts/authoring-resource-discovery.js";

describe("Studio authoring resource discovery", () => {
  it("pins every canonical workflow agent reference shape", () => {
    const discovered = discoverStudioWorkflowResources([
      "id: canonical",
      "type: workflow",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "capabilities: [quality-gates]",
      "nodes:",
      "  - id: plan",
      "    type: agent",
      "    agent: planner",
      "    output_schema: plan.schema.json",
      "  - id: implement",
      "    type: pattern",
      "    uses: quality-gates.gated_agent_loop",
      "    worker: implementer",
      "    gates:",
      "      - id: review",
      "        type: quality-gates.semantic_review",
      "        input:",
      "          review_agent: change-reviewer",
      ""
    ].join("\n"));

    expect(discovered).toMatchObject({ canonical: true });
    expect(discovered.agents).toEqual([
      {
        resource: { kind: "agent", id: "planner" },
        outputSchema: "plan.schema.json"
      },
      { resource: { kind: "agent", id: "implementer" } },
      { resource: { kind: "agent", id: "change-reviewer" } }
    ]);
    expect(discovered.workflows).toEqual([]);
  });

  it("falls back to a conservative closure for invalid definitions", () => {
    expect(
      discoverStudioWorkflowResources("nodes: [not canonical")
    ).toEqual({
      editable: ["input.schema.json", "output.schema.json"],
      agents: [],
      workflows: [],
      canonical: false
    });
    expect(discoverStudioAgentResources("id: incomplete\n")).toEqual({
      editable: ["instructions.md", "output.schema.json"],
      canonical: false
    });
  });
});
