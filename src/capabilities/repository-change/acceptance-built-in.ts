import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  requiredInput,
  resolvedInput
} from "../../core/built-ins/state.js";
import { recordAcceptanceDecisionMetadata } from "./metadata.js";

export const recordAcceptanceDecisionBuiltIn = defineBuiltInStep({
  name: "repository-change.record_acceptance_decision",
  metadata: recordAcceptanceDecisionMetadata,
  run({ state, input }) {
    const resolved = resolvedInput(input, state);
    return requiredInput(resolved.acceptance, "acceptance");
  }
});
