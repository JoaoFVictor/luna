import {
  buildImplementationReportJson as defaultBuildImplementationReportJson,
  buildImplementationReportMarkdown as defaultBuildImplementationReportMarkdown
} from "./report-builder.js";
import { jiraIssueContextFrom } from "./task-context.js";
import type { ChangeRequestArtifact } from "../../change-request/contracts.js";
import type {
  Invocation,
  ValidationResult
} from "../../types.js";
import type {
  CommitChangesArtifact,
  PushBranchArtifact
} from "../../write-mode/types.js";
import { defineBuiltInStep } from "../../built-ins/registry.js";
import {
  finalValidationFrom,
  implementationWorkspaceFrom,
  requiredImplementationFrom,
  requiredState,
  resolvedInput,
  stepValue
} from "../../built-ins/state.js";
import { builtInError } from "../../built-ins/errors.js";

function jiraIssueInvocationFrom(state: { invocation?: unknown }): Invocation {
  const invocation = requiredState(
    state.invocation as Invocation | undefined,
    "invocation"
  );

  try {
    jiraIssueContextFrom(invocation);
  } catch {
    throw builtInError(
      "Built-in step requires Jira issue invocation",
      "built_in_unsupported"
    );
  }

  return invocation;
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

export const collectTaskContextBuiltIn = defineBuiltInStep({
  name: "collect_task_context",
  run({ state }) {
    const task = jiraIssueContextFrom(jiraIssueInvocationFrom(state));
    const title = `${task.issueKey}: ${task.title ?? task.issueKey}`;

    return {
      implementation_title: title,
      implementation_subject: {
        key: task.issueKey,
        title: task.title
      },
      jira: {
        issue_key: task.issueKey,
        summary: task.title ?? "",
        description: task.description,
        acceptance_criteria: task.acceptanceCriteria
      },
      repository: task.repository
    };
  }
});

export const finalImplementationReportBuiltIn = defineBuiltInStep({
  name: "final_implementation_report",
  metadata: { deferredLifecycle: "final_report" },
  run({ state, input, dependencies = {} }) {
    const buildImplementationReportJson =
      dependencies.buildImplementationReportJson ??
      defaultBuildImplementationReportJson;
    const buildImplementationReportMarkdown =
      dependencies.buildImplementationReportMarkdown ??
      defaultBuildImplementationReportMarkdown;
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
    const reportInput = {
      invocation: jiraIssueInvocationFrom(state),
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
        requiredImplementationFrom(state).sandbox.type === "trusted_host_local"
    };

    return {
      json: buildImplementationReportJson(reportInput),
      markdown: buildImplementationReportMarkdown(reportInput)
    };
  }
});
