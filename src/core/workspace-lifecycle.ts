import type { ImplementationLifecycleEvidence } from "./implementation-lifecycle.js";

export function shouldPreserveWriteWorkspace(input: {
  commitEnabled: boolean;
  pushEnabled: boolean;
  pullRequestEnabled: boolean;
  acceptanceAccepted: boolean;
  evidence: ImplementationLifecycleEvidence;
}): { preserve: boolean; reason: string } {
  if (!input.commitEnabled) {
    return { preserve: true, reason: "commit_disabled" };
  }

  if (!input.evidence.validationRan || !input.evidence.validationPassed) {
    return { preserve: true, reason: "validation_failed" };
  }

  if (!input.acceptanceAccepted) {
    return { preserve: true, reason: "acceptance_failed" };
  }

  if (!input.evidence.commitAttempted || !input.evidence.commitSucceeded) {
    return { preserve: true, reason: "commit_skipped_or_failed" };
  }

  if (input.pushEnabled && !input.evidence.pushAttempted) {
    return { preserve: true, reason: "push_skipped_or_failed" };
  }

  if (input.pullRequestEnabled && !input.evidence.pullRequestAttempted) {
    return { preserve: true, reason: "pull_request_skipped_or_failed" };
  }

  return { preserve: false, reason: "success_cleanup" };
}
