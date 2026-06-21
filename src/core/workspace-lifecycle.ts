import type { ImplementationLifecycleEvidence } from "./implementation-lifecycle.js";

export function workspaceLifecycleDecision(
  evidence: ImplementationLifecycleEvidence,
  workflowResult: {
    commitEnabled: boolean;
    pushEnabled: boolean;
    changeRequestEnabled: boolean;
  }
): { preserve: boolean; reason: string } {
  if (!workflowResult.commitEnabled) {
    return { preserve: true, reason: "commit_disabled" };
  }

  if (!evidence.validationRan || !evidence.validationPassed) {
    return { preserve: true, reason: "validation_failed" };
  }

  if (!evidence.acceptanceAccepted) {
    return { preserve: true, reason: "acceptance_failed" };
  }

  if (!evidence.commitAttempted || !evidence.commitSucceeded) {
    return { preserve: true, reason: "commit_skipped_or_failed" };
  }

  if (workflowResult.pushEnabled && !evidence.pushAttempted) {
    return { preserve: true, reason: "push_skipped_or_failed" };
  }

  if (workflowResult.changeRequestEnabled && !evidence.changeRequestAttempted) {
    return { preserve: true, reason: "change_request_skipped_or_failed" };
  }

  return { preserve: false, reason: "success_cleanup" };
}
