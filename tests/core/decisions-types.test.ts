import { describe, expect, it } from "vitest";
import { AcceptanceDecisionSchema } from "../../src/core/decisions/types.js";

const validAcceptanceDecision = {
  status: "rejected",
  summary: "One high-confidence authorization issue remains.",
  blocking_reasons: ["Missing authorization check"],
  recommended_action: "request_changes"
};

describe("decision zod schemas", () => {
  it("accepts valid AcceptanceDecision output", () => {
    expect(AcceptanceDecisionSchema.parse(validAcceptanceDecision)).toEqual(
      validAcceptanceDecision
    );
  });
});
