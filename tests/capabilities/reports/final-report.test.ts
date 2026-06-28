import { describe, expect, it } from "vitest";
import { renderFinalReport } from "../../../src/capabilities/reports/final-report.js";
import { createSummaryProjection } from "../../../src/core/observability/tracing.js";

describe("reports capability final_report", () => {
  it("renders sections in declared order", () => {
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
    const summary = createSummaryProjection([
      {
        type: "span.ended",
        span: {
          schema_version: 1,
          trace_id: "trace-1",
          span_id: "span-1",
          run_id: "run-1",
          workflow_id: "code-review",
          attempt: 1,
          name: "agent.review",
          kind: "agent",
          status: "ok",
          started_at: "2026-06-28T00:00:00.000Z",
          ended_at: "2026-06-28T00:00:00.025Z",
          duration_ms: 25,
          attributes: {},
          metadata: {},
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 2,
            cache_write_tokens: 1,
            total_tokens: 18,
            cost: {
              input: 0.01,
              output: 0.02,
              cache_read: 0.001,
              cache_write: 0.002,
              total: 0.033,
              unit: "provider_cost_unit"
            }
          }
        }
      }
    ]);

    const output = renderFinalReport(
      { title: "Run Summary", sections: [{ heading: "Result", content: "ok" }] },
      summary
    );

    expect(output.report).toContain("## Execution Summary");
    expect(output.execution).toMatchObject({ prompt_operations: 1 });
  });

});
