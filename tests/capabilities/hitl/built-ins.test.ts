import { describe, expect, it } from "vitest";
import { requireApprovalBuiltIn } from "../../../src/capabilities/hitl/built-ins.js";

describe("hitl capability built-ins", () => {
  it("passes approved decisions through as an explicit approval result", async () => {
    await expect(
      runRequireApproval({
        decision: {
          action: "approve",
          comment: "ship it"
        }
      })
    ).resolves.toEqual({
      action: "approve",
      status: "approved",
      comment: "ship it"
    });
  });

  it("rejects valid negative decisions before downstream side effects", async () => {
    await expect(
      runRequireApproval({
        decision: {
          action: "reject",
          comment: "not yet"
        }
      })
    ).rejects.toMatchObject({
      code: "built_in_rejected",
      message: "Human approval rejected the implementation workflow before side effects."
    });
  });

  it("does not accept loop-only change requests in the legacy approval built-in", async () => {
    await expect(
      runRequireApproval({
        decision: {
          action: "request_changes",
          comment: "make the image brighter",
          targets: ["image"]
        }
      })
    ).rejects.toMatchObject({ code: "built_in_input_invalid" });
  });

  it("rejects the removed approved compatibility field", async () => {
    await expect(
      runRequireApproval({ decision: { action: "approve", approved: false } })
    ).rejects.toMatchObject({ code: "built_in_input_invalid" });
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
