export function shouldPreserveWriteWorkspace(input: {
  commitEnabled: boolean;
  validationPassed: boolean;
  acceptanceAccepted: boolean;
  commitSkippedOrFailed: boolean;
  pushSkippedOrFailed: boolean;
  pullRequestSkippedOrFailed: boolean;
}): { preserve: boolean; reason: string } {
  if (!input.commitEnabled) {
    return { preserve: true, reason: "commit_disabled" };
  }

  if (!input.validationPassed) {
    return { preserve: true, reason: "validation_failed" };
  }

  if (!input.acceptanceAccepted) {
    return { preserve: true, reason: "acceptance_failed" };
  }

  if (input.commitSkippedOrFailed) {
    return { preserve: true, reason: "commit_skipped_or_failed" };
  }

  if (input.pushSkippedOrFailed) {
    return { preserve: true, reason: "push_skipped_or_failed" };
  }

  if (input.pullRequestSkippedOrFailed) {
    return { preserve: true, reason: "pull_request_skipped_or_failed" };
  }

  return { preserve: false, reason: "success_cleanup" };
}
