import { describe, expect, it } from "vitest";
import { ReviewPlanSchema } from "../../src/core/code-review/types.js";

const validReviewPlan = {
  summary: "Review the changed authentication flow.",
  focus_areas: ["Input validation", "Authorization checks"],
  files_to_review: ["src/auth.ts"]
};

describe("code review zod schemas", () => {
  it("accepts valid ReviewPlan output", () => {
    expect(ReviewPlanSchema.parse(validReviewPlan)).toEqual(validReviewPlan);
  });
});
