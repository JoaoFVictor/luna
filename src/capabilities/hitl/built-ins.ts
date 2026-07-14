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
      required: ["action"],
      properties: {
        action: { enum: ["approve", "reject"] },
        comment: { type: "string" }
      }
    }
  }
} as const;

export const approvalRequiredOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "status"],
  properties: {
    action: { enum: ["approve"] },
    status: { enum: ["approved"] },
    comment: { type: "string" }
  }
} as const;

export const requireApprovalBuiltIn = defineBuiltInStep({
  name: "hitl.require_approval",
  async run({ input }) {
    const decision = decisionFromInput(input);
    if (decision.action !== "approve") {
      throw builtInError(
        "Human approval rejected the implementation workflow before side effects.",
        "built_in_rejected"
      );
    }

    return {
      action: "approve",
      status: "approved",
      ...(decision.comment === undefined ? {} : { comment: decision.comment })
    };
  }
});

function decisionFromInput(input: unknown): {
  action: "approve" | "reject";
  comment?: string;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw builtInError("HITL approval input must be an object.", "built_in_input_invalid");
  }

  const decision = (input as { decision?: unknown }).decision;
  if (typeof decision !== "object" || decision === null || Array.isArray(decision)) {
    throw builtInError("HITL approval input.decision must be an object.", "built_in_input_invalid");
  }

  const candidate = decision as { action?: unknown; comment?: unknown };
  const unsupportedField = Object.keys(decision).find(
    (key) => key !== "action" && key !== "comment"
  );
  if (unsupportedField !== undefined) {
    throw builtInError(
      `HITL approval input.decision.${unsupportedField} is not supported.`,
      "built_in_input_invalid"
    );
  }
  if (candidate.comment !== undefined && typeof candidate.comment !== "string") {
    throw builtInError(
      "HITL approval input.decision.comment must be a string.",
      "built_in_input_invalid"
    );
  }
  const action = candidate.action;
  if (action !== "approve" && action !== "reject") {
    throw builtInError(
      "HITL approval input.decision.action is invalid.",
      "built_in_input_invalid"
    );
  }
  return {
    action,
    ...(candidate.comment === undefined ? {} : { comment: candidate.comment })
  };
}
