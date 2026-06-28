import { builtInError } from "../../core/built-ins/errors.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";

export const approvalRequiredInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision"],
  properties: {
    decision: {
      type: "object",
      additionalProperties: false,
      required: ["approved"],
      properties: {
        approved: { type: "boolean" },
        comment: { type: "string" }
      }
    }
  }
} as const;

export const approvalRequiredOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "status"],
  properties: {
    approved: { type: "boolean" },
    status: { enum: ["approved"] },
    comment: { type: "string" }
  }
} as const;

export const requireApprovalBuiltIn = defineBuiltInStep({
  name: "hitl.require_approval",
  async run({ input }) {
    const decision = decisionFromInput(input);
    if (!decision.approved) {
      throw builtInError(
        "Human approval rejected the implementation workflow before side effects.",
        "built_in_rejected"
      );
    }

    return {
      approved: true,
      status: "approved",
      ...(decision.comment === undefined ? {} : { comment: decision.comment })
    };
  }
});

function decisionFromInput(input: unknown): { approved: boolean; comment?: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw builtInError("HITL approval input must be an object.", "built_in_input_invalid");
  }

  const decision = (input as { decision?: unknown }).decision;
  if (typeof decision !== "object" || decision === null || Array.isArray(decision)) {
    throw builtInError("HITL approval input.decision must be an object.", "built_in_input_invalid");
  }

  const candidate = decision as { approved?: unknown; comment?: unknown };
  if (typeof candidate.approved !== "boolean") {
    throw builtInError(
      "HITL approval input.decision.approved must be a boolean.",
      "built_in_input_invalid"
    );
  }
  if (candidate.comment !== undefined && typeof candidate.comment !== "string") {
    throw builtInError(
      "HITL approval input.decision.comment must be a string.",
      "built_in_input_invalid"
    );
  }

  return {
    approved: candidate.approved,
    ...(candidate.comment === undefined ? {} : { comment: candidate.comment })
  };
}
