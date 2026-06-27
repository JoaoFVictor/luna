import {
  ChangeRequestArtifactSchema,
  type ChangeRequestArtifact
} from "../change-request/contracts.js";
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

export type ImplementationReportRenderer = (input: ImplementationReportInput) => unknown;
export type ImplementationReportMarkdownRenderer = (
  input: ImplementationReportInput
) => string;

function isImplementationReportRenderer(
  value: unknown
): value is ImplementationReportRenderer {
  return typeof value === "function";
}

function isImplementationReportMarkdownRenderer(
  value: unknown
): value is ImplementationReportMarkdownRenderer {
  return typeof value === "function";
}

export function implementationReportRenderersFrom({
  dependencies = {},
  defaultBuildJson,
  defaultBuildMarkdown
}: {
  dependencies?: Record<string, unknown>;
  defaultBuildJson: ImplementationReportRenderer;
  defaultBuildMarkdown: ImplementationReportMarkdownRenderer;
}): {
  buildJson: ImplementationReportRenderer;
  buildMarkdown: ImplementationReportMarkdownRenderer;
} {
  return {
    buildJson: isImplementationReportRenderer(dependencies.buildImplementationReportJson)
      ? dependencies.buildImplementationReportJson
      : defaultBuildJson,
    buildMarkdown: isImplementationReportMarkdownRenderer(
      dependencies.buildImplementationReportMarkdown
    )
      ? dependencies.buildImplementationReportMarkdown
      : defaultBuildMarkdown
  };
}

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

function changeRequestArtifactFrom(value: unknown): ChangeRequestArtifact {
  const result = ChangeRequestArtifactSchema.safeParse(value);
  if (!result.success) {
    throw new Error("final_implementation_report requires ChangeRequestArtifact");
  }

  return result.data;
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
    "commit_lifecycle"
  );
  const push = stepValue<PushBranchArtifact>(
    state,
    resolved,
    "push",
    "push_lifecycle"
  );
  const changeRequest = changeRequestArtifactFrom(
    stepValue<unknown>(state, resolved, "change_request", "change_request")
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
