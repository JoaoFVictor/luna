import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../../src/core/json/value.js";
import { compareRunNodeOutputs } from "../../../src/studio/application/runs/node-output-comparison.js";
import {
  MAX_RUN_NODE_OUTPUT_COMPARISON_CHANGES,
  RunNodeOutputComparisonResponseSchema,
  RunNodeOutputResponseSchema,
  type RunNodeOutputResponse
} from "../../../src/studio/contracts/run-node-output.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function availableOutput(input: {
  readonly runId: string;
  readonly value: JsonValue;
  readonly workflowId?: string;
  readonly workflowRevision?: string;
}): RunNodeOutputResponse {
  return RunNodeOutputResponseSchema.parse({
    schema_version: 1,
    availability: "available",
    run: {
      run_id: input.runId,
      workflow_id: input.workflowId ?? "code-review",
      workflow_revision: input.workflowRevision ?? DIGEST,
      definition_bundle_hash: DIGEST,
      execution_snapshot_hash: DIGEST,
      status: "succeeded",
      completeness: "complete"
    },
    node_id: "review",
    graph_hash: DIGEST,
    outcome_hash: DIGEST,
    output: {
      availability: "available",
      value: input.value,
      redaction: { mode: "best_effort", changed: false }
    }
  });
}

describe("run node output comparison", () => {
  it("compares nested retained JSON deterministically", () => {
    const result = compareRunNodeOutputs({
      baseline: availableOutput({
        runId: "run-before",
        value: {
          list: [1, 2],
          name: "before",
          nested: { kept: true, removed: 1 },
          secret: "[REDACTED]"
        }
      }),
      current: availableOutput({
        runId: "run-after",
        value: {
          list: [1, 3, 4],
          name: "after",
          nested: { added: 2, kept: true },
          secret: "[REDACTED]"
        }
      })
    });

    expect(result).toMatchObject({
      availability: "comparable",
      same_workflow_revision: true,
      summary: { added: 2, removed: 1, changed: 2, total: 5 },
      truncated: false,
      redaction: "best_effort"
    });
    if (result.availability !== "comparable") throw new Error("not comparable");
    expect(result.changes.map((change) => [change.kind, change.path])).toEqual([
      ["changed", ["list", "1"]],
      ["added", ["list", "2"]],
      ["changed", ["name"]],
      ["added", ["nested", "added"]],
      ["removed", ["nested", "removed"]]
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("counts every difference while bounding response detail", () => {
    const baseline = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`field-${index}`, 0])
    );
    const current = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`field-${index}`, 1])
    );
    const result = compareRunNodeOutputs({
      baseline: availableOutput({ runId: "run-before", value: baseline }),
      current: availableOutput({ runId: "run-after", value: current })
    });

    expect(result).toMatchObject({
      availability: "comparable",
      summary: { changed: 600, total: 600 },
      truncated: true
    });
    if (result.availability !== "comparable") throw new Error("not comparable");
    expect(result.changes).toHaveLength(MAX_RUN_NODE_OUTPUT_COMPARISON_CHANGES);
  });

  it("refuses cross-workflow comparisons before exposing values", () => {
    const result = compareRunNodeOutputs({
      baseline: availableOutput({
        runId: "run-before",
        workflowId: "other-workflow",
        value: { private: "secret-before-value" }
      }),
      current: availableOutput({
        runId: "run-after",
        value: { private: "secret-after-value" }
      })
    });

    expect(result).toMatchObject({
      availability: "unavailable",
      reason: "workflow_mismatch",
      unavailable_sides: []
    });
    expect(JSON.stringify(result)).not.toContain("secret-before-value");
    expect(JSON.stringify(result)).not.toContain("secret-after-value");
  });

  it("preserves the existing retention reason for either side", () => {
    const current = availableOutput({ runId: "run-after", value: { ok: true } });
    const baseline = RunNodeOutputResponseSchema.parse({
      ...current,
      run: { ...current.run, run_id: "run-before" },
      output: {
        availability: "unavailable",
        reason: "snapshot_budget_exhausted"
      }
    });

    expect(compareRunNodeOutputs({ baseline, current })).toMatchObject({
      availability: "unavailable",
      reason: "output_unavailable",
      unavailable_sides: [
        { side: "baseline", reason: "snapshot_budget_exhausted" }
      ]
    });
  });

  it("rejects contradictory comparison summaries at the contract boundary", () => {
    const valid = compareRunNodeOutputs({
      baseline: availableOutput({ runId: "run-before", value: { score: 1 } }),
      current: availableOutput({ runId: "run-after", value: { score: 2 } })
    });
    expect(valid.availability).toBe("comparable");
    expect(() => RunNodeOutputComparisonResponseSchema.parse({
      ...valid,
      summary: { added: 0, removed: 0, changed: 1, total: 99 },
      truncated: true
    })).toThrow(/categorized counts/);
  });
});
