import { describe, expect, it } from "vitest";
import { requireApprovalBuiltIn } from "../../../src/capabilities/hitl/built-ins.js";

describe("hitl capability built-ins", () => {
  it("passes approved decisions through as an explicit approval result", async () => {
    await expect(
      runRequireApproval({
        decision: {
          approved: true,
          comment: "ship it"
        }
      })
    ).resolves.toEqual({
      approved: true,
      status: "approved",
      comment: "ship it"
    });
  });

  it("rejects valid negative decisions before downstream side effects", async () => {
    await expect(
      runRequireApproval({
        decision: {
          approved: false,
          comment: "not yet"
        }
      })
    ).rejects.toMatchObject({
      code: "built_in_rejected",
      message: "Human approval rejected the implementation workflow before side effects."
    });
  });
});

function runRequireApproval(input: Record<string, unknown>) {
  return requireApprovalBuiltIn.run({
    state: {
      invocation: {},
      steps: {}
    },
    input
  });
}
