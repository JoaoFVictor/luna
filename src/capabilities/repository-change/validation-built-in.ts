import { GatedAgentLoopResultSchema } from "../../core/agent-runtime/contracts.js";
import type { AcceptanceDecision } from "../../core/decisions/types.js";
import { AcceptanceDecisionSchema } from "../../core/decisions/types.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  requiredInput,
  resolvedInput
} from "../../core/built-ins/state.js";
import { recordImplementationValidationMetadata } from "./metadata.js";
import { WorktreeDiffSchema } from "../git/diff/worktree-diff.js";
import {
  ApprovedWorktreeSnapshotSchema,
  worktreeSnapshotsEqual
} from "../git/worktree-snapshot.js";

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
    const diffSummary = WorktreeDiffSchema.safeParse(implementation.result.diff_summary);
    const validatedSnapshot = ApprovedWorktreeSnapshotSchema.safeParse(
      implementation.result.validated_snapshot
    );
    const approvedSnapshot = validatedSnapshot.success
      ? validatedSnapshot.data
      : undefined;
    if (
      implementation.status === "passed" &&
      (
        approvedSnapshot === undefined ||
        !diffSummary.success ||
        diffSummary.data.approved_snapshot === undefined ||
        !worktreeSnapshotsEqual(diffSummary.data.approved_snapshot, approvedSnapshot)
      )
    ) {
      throw new Error(
        "Passed implementation lacks one exact Git tree shared by validation and diff review."
      );
    }

    return {
      validation: implementation.final_validation,
      acceptance,
      ...(approvedSnapshot === undefined ? {} : { approved_snapshot: approvedSnapshot })
    };
  }
});
