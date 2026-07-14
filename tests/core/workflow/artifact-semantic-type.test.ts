import { describe, expect, it } from "vitest";
import {
  assertWorkflowDocument,
  parseWorkflowYaml,
  readGraph
} from "../../../src/core/workflow/definition-schema.js";

function workflowYaml(semanticType?: string): string {
  return `
id: semantic-artifact
type: workflow
input_schema: input.schema.json
output_schema: output.schema.json
nodes:
  - id: report
    type: built_in
    uses: reports.final_report
    artifacts:
      - path: report.json
        publisher: artifacts.manifest_publisher
        ${semanticType === undefined ? "" : `semantic_type: ${semanticType}`}
        source:
          expression: $.steps.report
        format: json
`;
}

describe("workflow artifact semantic_type", () => {
  it("parses a bounded versioned semantic type and keeps legacy plans valid", () => {
    const graph = readGraph(
      assertWorkflowDocument(parseWorkflowYaml(workflowYaml("luna.review.findings.v1")))
    );
    const report = graph.nodes[0];
    expect(report?.type).toBe("built_in");
    if (report?.type !== "built_in") throw new Error("Expected built-in report node");
    expect(report.artifacts?.[0]).toMatchObject({
      semantic_type: "luna.review.findings.v1"
    });

    const legacy = readGraph(
      assertWorkflowDocument(parseWorkflowYaml(workflowYaml()))
    );
    const legacyReport = legacy.nodes[0];
    expect(legacyReport?.type).toBe("built_in");
    if (legacyReport?.type !== "built_in") {
      throw new Error("Expected built-in report node");
    }
    expect(legacyReport.artifacts?.[0]).not.toHaveProperty("semantic_type");
  });

  it.each([
    "findings",
    "Luna.review.findings.v1",
    "luna.review.findings.v0",
    `luna.review.${"x".repeat(128)}.v1`
  ])("rejects invalid semantic type %s", (semanticType) => {
    expect(() =>
      readGraph(
        assertWorkflowDocument(parseWorkflowYaml(workflowYaml(semanticType)))
      )
    ).toThrow(/semantic_type/);
  });
});
