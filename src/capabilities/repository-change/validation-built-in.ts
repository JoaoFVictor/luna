import { GatedAgentLoopResultSchema } from "../../core/agent-runtime/contracts.js";
import type { AcceptanceDecision } from "../../core/decisions/types.js";
import { AcceptanceDecisionSchema } from "../../core/decisions/types.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  requiredInput,
  resolvedInput
} from "../../core/built-ins/state.js";
import { recordImplementationValidationMetadata } from "./metadata.js";

function fallbackRejectedAcceptance(implementation: {
  readonly result: unknown;
}): AcceptanceDecision {
  const message = agentErrorMessage(implementation.result) ??
    "Implementation did not produce a reviewable result.";

  return {
    status: "rejected",
    summary: `Implementation failed before acceptance review: ${message}`,
    blocking_reasons: [message],
    recommended_action: "stop"
  };
}

function agentErrorMessage(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return undefined;
  }

  const agentError = (result as { agent_error?: unknown }).agent_error;
  if (typeof agentError !== "object" || agentError === null || Array.isArray(agentError)) {
    return undefined;
  }

  const message = (agentError as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

export const recordImplementationValidationBuiltIn = defineBuiltInStep({
  name: "repository-change.record_validation",
  metadata: recordImplementationValidationMetadata,
  run({ state, input }) {
    const resolved = resolvedInput(input, state);
    const implementation = GatedAgentLoopResultSchema.parse(
      requiredInput(resolved.implementation, "implementation")
    );
    const acceptance =
      implementation.result.acceptance === undefined
        ? fallbackRejectedAcceptance(implementation)
        : AcceptanceDecisionSchema.parse(implementation.result.acceptance);

    return {
      validation: implementation.final_validation,
      acceptance
    };
  }
});
