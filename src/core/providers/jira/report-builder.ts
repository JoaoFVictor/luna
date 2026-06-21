import { jiraIssueContextFrom } from "./task-context.js";
import type {
  ChangeRequestArtifact,
  CommitChangesArtifact,
  Invocation,
  InvocationRepository,
  PushBranchArtifact,
  ValidationResult
} from "../../types.js";

type ImplementationWorktreeSummary = {
  path: string;
  preserved: boolean;
  reason: string;
};

type ReportInput = {
  invocation: Invocation;
  status: string;
  branch: string;
  worktree: ImplementationWorktreeSummary;
  validation: ValidationResult;
  commit: CommitChangesArtifact;
  push: PushBranchArtifact;
  changeRequest: ChangeRequestArtifact;
  trustedHostLocal: boolean;
};

type ActionJson = {
  enabled: boolean;
  skipped: boolean;
  status: string;
  reason?: string;
};

export type ImplementationReportJson = {
  jira: {
    key: string;
    url: string;
    summary: string;
    status: string;
  };
  repository: InvocationRepository;
  status: string;
  branch: string;
  worktree: ImplementationWorktreeSummary;
  validation: {
    passed: boolean;
    command_count: number;
  };
  commit: ActionJson & Pick<CommitChangesArtifact, "branch" | "commit_sha">;
  push: ActionJson & Pick<PushBranchArtifact, "remote" | "branch">;
  change_request: ActionJson & Pick<ChangeRequestArtifact, "provider" | "url">;
  warnings: string[];
};

const trustedHostLocalWarning =
  "trusted_host_local execution can access host filesystem, credentials, network, and local CLIs.";

function actionStatus({
  artifact,
  success
}: {
  artifact: { enabled: boolean; skipped: boolean; reason?: string };
  success: string;
}): ActionJson {
  if (!artifact.enabled) {
    return {
      enabled: artifact.enabled,
      skipped: artifact.skipped,
      status: "disabled",
      reason: artifact.reason
    };
  }

  if (artifact.skipped) {
    return {
      enabled: artifact.enabled,
      skipped: artifact.skipped,
      status: "skipped",
      reason: artifact.reason
    };
  }

  return {
    enabled: artifact.enabled,
    skipped: artifact.skipped,
    status: success,
    reason: artifact.reason
  };
}

export function buildImplementationReportJson({
  invocation,
  status,
  branch,
  worktree,
  validation,
  commit,
  push,
  changeRequest,
  trustedHostLocal
}: ReportInput): ImplementationReportJson {
  const task = jiraIssueContextFrom(invocation);

  return {
    jira: {
      key: task.issueKey,
      url: task.url ?? "",
      summary: task.title ?? "",
      status: task.status
    },
    repository: task.repository,
    status,
    branch,
    worktree,
    validation: {
      passed: validation.passed,
      command_count: validation.commands?.length ?? 0
    },
    commit: {
      ...actionStatus({ artifact: commit, success: "created" }),
      branch: commit.branch,
      commit_sha: commit.commit_sha
    },
    push: {
      ...actionStatus({ artifact: push, success: "pushed" }),
      remote: push.remote,
      branch: push.branch
    },
    change_request: {
      ...actionStatus({ artifact: changeRequest, success: "opened" }),
      provider: changeRequest.provider,
      url: changeRequest.url
    },
    warnings: trustedHostLocal ? [trustedHostLocalWarning] : []
  };
}

export function buildImplementationReportMarkdown(input: ReportInput): string {
  const report = buildImplementationReportJson(input);
  const worktreeState = report.worktree.preserved ? "preserved" : "removed";
  const lines = [
    "# Luna Implementation Report",
    "",
    `Jira: ${report.jira.key}`,
    `Status: ${report.status}`,
    `Branch: ${report.branch}`,
    `Worktree: ${report.worktree.path}`,
    `Worktree state: ${worktreeState} (${report.worktree.reason})`,
    `Validation: ${report.validation.passed ? "passed" : "failed"}`,
    `Commit: ${report.commit.status}`,
    `Push: ${report.push.status}`,
    `Change request: ${report.change_request.status}`
  ];

  if (report.commit.reason !== undefined) {
    lines.push(`Commit reason: ${report.commit.reason}`);
  }

  if (report.push.reason !== undefined) {
    lines.push(`Push reason: ${report.push.reason}`);
  }

  if (report.change_request.reason !== undefined) {
    lines.push(`Change request reason: ${report.change_request.reason}`);
  }

  if (report.change_request.url !== undefined) {
    lines.push(`Change request URL: ${report.change_request.url}`);
  }

  if (report.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...report.warnings.map((warning) => `- ${warning}`));
  }

  return `${lines.join("\n")}\n`;
}
