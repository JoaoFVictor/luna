import {
  executionSummaryJson,
  executionSummaryMarkdownLines,
  type ExecutionSummaryJson
} from "./execution-summary.js";
import type { ChangeRequestArtifact } from "../change-request/contracts.js";
import type { Invocation, InvocationRepository } from "../router/invocation.js";
import type { ObservabilitySummary } from "../observability/summary.js";
import type { ValidationResult } from "../validation/runner.js";
import type {
  CommitChangesArtifact,
  PushBranchArtifact
} from "../write-mode/types.js";

export type ImplementationReportInput = {
  invocation: Invocation;
  status: string;
  branch: string;
  worktree: {
    path: string;
    preserved: boolean;
    reason: string;
  };
  validation: ValidationResult;
  commit: CommitChangesArtifact;
  push: PushBranchArtifact;
  changeRequest: ChangeRequestArtifact;
  trustedHostLocal: boolean;
  summary?: ObservabilitySummary;
};

export type ImplementationWorktreeSummary = {
  path: string;
  preserved: boolean;
  reason: string;
};

export type ImplementationActionJson = {
  enabled: boolean;
  skipped: boolean;
  status: string;
  reason?: string;
};

export type ImplementationTaskSummary<Provider extends string> = {
  provider: Provider;
  key: string;
  id: string;
  url: string;
  title: string;
  status: string;
};

export type ImplementationReportCommonJson<Provider extends string> = {
  task: ImplementationTaskSummary<Provider>;
  repository: InvocationRepository;
  status: string;
  branch: string;
  worktree: ImplementationWorktreeSummary;
  validation: {
    passed: boolean;
    command_count: number;
  };
  commit: ImplementationActionJson &
    Pick<CommitChangesArtifact, "branch" | "commit_sha">;
  push: ImplementationActionJson & Pick<PushBranchArtifact, "remote" | "branch">;
  change_request: ImplementationActionJson &
    Pick<ChangeRequestArtifact, "provider" | "url">;
  warnings: string[];
  execution?: ExecutionSummaryJson;
};

const trustedHostLocalWarning =
  "trusted_host_local execution can access host filesystem, credentials, network, and local CLIs.";

function actionStatus({
  artifact,
  success
}: {
  artifact: { enabled: boolean; skipped: boolean; reason?: string };
  success: string;
}): ImplementationActionJson {
  if (!artifact.enabled) {
    return {
      enabled: artifact.enabled,
      skipped: artifact.skipped,
      status: "disabled",
      ...(artifact.reason === undefined ? {} : { reason: artifact.reason })
    };
  }

  if (artifact.skipped) {
    return {
      enabled: artifact.enabled,
      skipped: artifact.skipped,
      status: "skipped",
      ...(artifact.reason === undefined ? {} : { reason: artifact.reason })
    };
  }

  return {
    enabled: artifact.enabled,
    skipped: artifact.skipped,
    status: success
  };
}

export function buildImplementationReportCommonJson<Provider extends string>({
  input,
  task,
  repository
}: {
  input: ImplementationReportInput;
  task: ImplementationTaskSummary<Provider>;
  repository: InvocationRepository;
}): ImplementationReportCommonJson<Provider> {
  const execution = executionSummaryJson(input.summary);

  return {
    task,
    repository,
    status: input.status,
    branch: input.branch,
    worktree: input.worktree,
    validation: {
      passed: input.validation.passed,
      command_count: input.validation.commands?.length ?? 0
    },
    commit: {
      ...actionStatus({ artifact: input.commit, success: "created" }),
      ...(input.commit.branch === undefined ? {} : { branch: input.commit.branch }),
      ...(input.commit.commit_sha === undefined
        ? {}
        : { commit_sha: input.commit.commit_sha })
    },
    push: {
      ...actionStatus({ artifact: input.push, success: "pushed" }),
      ...(input.push.remote === undefined ? {} : { remote: input.push.remote }),
      ...(input.push.branch === undefined ? {} : { branch: input.push.branch })
    },
    change_request: {
      ...actionStatus({ artifact: input.changeRequest, success: "opened" }),
      ...(input.changeRequest.provider === undefined
        ? {}
        : { provider: input.changeRequest.provider }),
      ...(input.changeRequest.url === undefined ? {} : { url: input.changeRequest.url })
    },
    warnings: input.trustedHostLocal ? [trustedHostLocalWarning] : [],
    ...(execution === undefined ? {} : { execution })
  };
}

export function buildImplementationReportMarkdown({
  report,
  taskLine,
  summary
}: {
  report: ImplementationReportCommonJson<string>;
  taskLine: string;
  summary: ImplementationReportInput["summary"];
}): string {
  const worktreeState = report.worktree.preserved ? "preserved" : "removed";
  const lines = [
    "# Luna Implementation Report",
    "",
    taskLine,
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

  lines.push(...executionSummaryMarkdownLines(summary));

  return `${lines.join("\n")}\n`;
}
