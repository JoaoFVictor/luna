import type { ChangeRequestArtifact } from "../change-request/contracts.js";
import type { BuiltInStepRunOptions } from "./types.js";
import type { Invocation } from "../router/invocation.js";
import type { ValidationResult } from "../validation/runner.js";
import type {
  CommitChangesArtifact,
  PushBranchArtifact
} from "../write-mode/types.js";
import type { ImplementationReportInput } from "../reports/implementation-report.js";
import {
  finalValidationFrom,
  implementationWorkspaceFrom,
  requiredImplementationFrom,
  resolvedInput,
  stepValue
} from "./state.js";

function implementationReportStatus({
  validation,
  commit,
  push,
  changeRequest
}: {
  validation: ValidationResult;
  commit: CommitChangesArtifact;
  push: PushBranchArtifact;
  changeRequest: ChangeRequestArtifact;
}): string {
  if (!validation.passed) {
    return "validation_failed";
  }

  if (!commit.skipped && !push.skipped && !changeRequest.skipped) {
    return "ready_for_change_request";
  }

  return "completed_with_skips";
}

export function implementationReportInputFrom({
  state,
  input,
  observabilitySummary,
  invocation
}: BuiltInStepRunOptions & {
  invocation: Invocation;
}): ImplementationReportInput {
  const resolved = resolvedInput(input, state);
  const workspace = implementationWorkspaceFrom(state);
  const validation = finalValidationFrom(state, resolved);
  const commit = stepValue<CommitChangesArtifact>(
    state,
    resolved,
    "commit",
    "commit"
  );
  const push = stepValue<PushBranchArtifact>(state, resolved, "push", "push");
  const changeRequest = stepValue<ChangeRequestArtifact>(
    state,
    resolved,
    "change_request",
    "change_request"
  );

  return {
    invocation,
    status: implementationReportStatus({
      validation,
      commit,
      push,
      changeRequest
    }),
    branch: workspace.branch,
    worktree: {
      path: workspace.path,
      preserved: workspace.preserved,
      reason: workspace.reason
    },
    validation,
    commit,
    push,
    changeRequest,
    trustedHostLocal:
      requiredImplementationFrom(state).sandbox.type === "trusted_host_local",
    ...(observabilitySummary === undefined
      ? {}
      : { summary: observabilitySummary })
  };
}
