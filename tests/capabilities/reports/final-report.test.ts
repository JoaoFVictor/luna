import { describe, expect, it } from "vitest";
import {
  finalReportOutputSchema,
  finalReportBuiltIn,
  renderFinalReport
} from "../../../src/capabilities/reports/final-report.js";
import { matchesJsonSchema } from "../../../src/core/capabilities/json-schema.js";

describe("reports capability final_report", () => {
  it("renders sections in declared order and validates output", () => {
    const output = renderFinalReport({
      title: "Run Summary",
      sections: [
        { heading: "Plan", content: "ready" },
        { heading: "Result", content: { status: "passed" } }
      ]
    });

    expect(output.report).toBe([
      "# Run Summary",
      "",
      "## Plan",
      "",
      "ready",
      "",
      "## Result",
      "",
      JSON.stringify({ status: "passed" }, null, 2)
    ].join("\n"));
    expect(matchesJsonSchema(finalReportOutputSchema, output)).toBe(true);
  });

  it("rejects invalid report inputs", () => {
    expect(() => renderFinalReport({ sections: "nope" })).toThrow(
      expect.objectContaining({ code: "built_in_input_invalid" })
    );

    expect(() => renderFinalReport({
      sections: [{ heading: "", content: "missing heading" }]
    })).toThrow(expect.objectContaining({ code: "built_in_input_invalid" }));
  });

  it("keeps final report deferred until finalization", () => {
    expect(finalReportBuiltIn.metadata).toMatchObject({
      deferredLifecycle: "final_report"
    });
  });
});
