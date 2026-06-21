import { describe, expect, it } from "vitest";
import {
  CodeReviewFindingsSchema,
  EvidenceRefSchema
} from "../../src/core/findings/types.js";

const validCodeReviewFindings = {
  findings: [
    {
      title: "Missing authorization check",
      severity: "high",
      confidence: "high",
      description: "The update path does not verify ownership.",
      evidence: [
        {
          path: "src/auth.ts",
          line_start: 12,
          line_end: 18,
          quote: "updateUser(request.body)"
        }
      ],
      recommendation: "Verify the caller owns the user record before updating it."
    }
  ]
};

describe("findings zod schemas", () => {
  it("rejects a finding without confidence", () => {
    const invalidFindings = {
      findings: [
        {
          title: "Missing authorization check",
          severity: "high",
          description: "The update path does not verify ownership.",
          evidence: [
            {
              path: "src/auth.ts",
              line_start: 12,
              line_end: 18
            }
          ],
          recommendation: "Verify the caller owns the user record before updating it."
        }
      ]
    };

    expect(() => CodeReviewFindingsSchema.parse(invalidFindings)).toThrow();
  });

  it("rejects an EvidenceRef range with line_end before line_start", () => {
    expect(() =>
      EvidenceRefSchema.parse({
        path: "src/auth.ts",
        line_start: 20,
        line_end: 19
      })
    ).toThrow();
  });

  it("accepts valid CodeReviewFindings output", () => {
    expect(CodeReviewFindingsSchema.parse(validCodeReviewFindings)).toEqual(
      validCodeReviewFindings
    );
  });
});
