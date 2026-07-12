import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../../src/core/json/value.js";
import { sha256Digest } from "../../../src/core/workflow/definition-digests.js";
import {
  StudioDraftTestDataSelectionsSchema,
  StudioManualTestDataListSchema,
  StudioManualTestDataSchema
} from "../../../src/studio/contracts/manual-test-data.js";
import { manualTestDataFromWorkflowLayout } from "../../../src/studio/application/drafts/manual-test-data-material.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function layout(options: { redacted?: boolean; steps?: JsonValue } = {}) {
  return {
    workflow: {
      expression_fixtures: {
        approved: {
          invocation: { ignored: true },
          config: { ignored: true },
          workspace: { ignored: true },
          steps: options.steps ?? { review: { summary: "approved" } }
        }
      },
      expression_fixture_sources: {
        approved: {
          kind: "run_node_output",
          run_id: "run-1",
          workflow_id: "code-review",
          node_id: "review",
          graph_hash: DIGEST,
          outcome_hash: DIGEST,
          workflow_revision: DIGEST,
          definition_bundle_hash: DIGEST,
          captured_at: "2026-07-11T10:00:03.000Z",
          redaction_changed: options.redacted ?? false,
          definition_source: { kind: "installed" }
        }
      }
    }
  } satisfies JsonValue;
}

describe("manual test data contract", () => {
  it("extracts only the authorized node output from an expression fixture", () => {
    const data = manualTestDataFromWorkflowLayout(layout(), {
      fixture_name: "approved"
    });

    expect(data).toEqual({
      kind: "draft_fixture",
      fixture_name: "approved",
      node_id: "review",
      output: { summary: "approved" },
      output_hash: sha256Digest({ summary: "approved" }),
      source: layout().workflow.expression_fixture_sources.approved
    });
    expect(data).not.toHaveProperty("invocation");
    expect(data).not.toHaveProperty("config");
    expect(data).not.toHaveProperty("workspace");
  });

  it("rejects redacted output and fixtures that contain unrelated steps", () => {
    expect(() => manualTestDataFromWorkflowLayout(layout({ redacted: true }), {
      fixture_name: "approved"
    })).toThrow(/redigida/u);
    expect(() => manualTestDataFromWorkflowLayout(layout({
      steps: { review: {}, context: {} }
    }), { fixture_name: "approved" })).toThrow(/exatamente/u);
  });

  it("binds the substituted node to its captured source", () => {
    const data = manualTestDataFromWorkflowLayout(layout(), {
      fixture_name: "approved"
    });
    expect(StudioManualTestDataSchema.safeParse({
      ...data,
      node_id: "another-node"
    }).success).toBe(false);
  });

  it("normalizes legacy single selection and sorts multiple selections", () => {
    expect(StudioDraftTestDataSelectionsSchema.parse({
      fixture_name: "approved"
    })).toEqual([{ fixture_name: "approved" }]);
    expect(StudioDraftTestDataSelectionsSchema.parse([
      { fixture_name: "zeta" },
      { fixture_name: "alpha" }
    ])).toEqual([
      { fixture_name: "alpha" },
      { fixture_name: "zeta" }
    ]);
    expect(StudioDraftTestDataSelectionsSchema.safeParse([
      { fixture_name: "approved" },
      { fixture_name: "approved" }
    ]).success).toBe(false);
  });

  it("sorts authorized material by node and rejects duplicate cutpoints", () => {
    const review = manualTestDataFromWorkflowLayout(layout(), {
      fixture_name: "approved"
    });
    const aggregate = {
      ...review,
      fixture_name: "aggregate",
      node_id: "aggregate",
      source: { ...review.source, node_id: "aggregate" }
    };
    expect(StudioManualTestDataListSchema.parse([review, aggregate]))
      .toEqual([aggregate, review]);
    expect(StudioManualTestDataListSchema.safeParse([
      review,
      { ...review, fixture_name: "duplicate" }
    ]).success).toBe(false);
  });
});
