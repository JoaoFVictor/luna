import { describe, expect, it } from "vitest";
import {
  finalReportOutputSchema,
  finalReportBuiltIn,
  renderFinalReport
} from "../../../src/core/reports/final-report.js";
import { matchesJsonSchema } from "../../../src/core/capabilities/json-schema.js";
import { createObservabilitySummary, recordPromptOperation, recordPromptUsage } from "../../../src/core/observability/summary.js";

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

  it("appends execution summary when observability is available", () => {
    const summary = createObservabilitySummary({
      runId: "run-1",
      workflowId: "code-review"
    });
    recordPromptOperation(summary, { durationMs: 25 });
    recordPromptUsage(summary, {
      prompt_id: "prompt-1",
      model_profile: "openai/gpt-5",
      provider: "openai",
      model: "gpt-5",
      tokens: {
        input: 10,
        output: 5,
        cache_read: 2,
        cache_write: 1,
        total: 18
      },
      cost: {
        input: 0.01,
        output: 0.02,
        cache_read: 0.001,
        cache_write: 0.002,
        total: 0.033,
        unit: "provider_cost_unit"
      }
    });

    const output = renderFinalReport(
      { title: "Run Summary", sections: [{ heading: "Result", content: "ok" }] },
      summary
    );

    expect(output.report).toContain("## Execution Summary");
    expect(output.report).toContain("Prompt operations: 1");
    expect(output.execution).toMatchObject({
      prompt_operations: 1,
      tokens: { total: 18 },
      cost: { total: 0.033 }
    });
    expect(matchesJsonSchema(finalReportOutputSchema, output)).toBe(true);
  });

  it("keeps final report deferred until finalization", () => {
    expect(finalReportBuiltIn.metadata).toMatchObject({
      deferredLifecycle: "final_report"
    });
  });
});
