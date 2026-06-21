import {
  prepareImplementationWorktree as defaultPrepareImplementationWorktree
} from "../implementation-worktree-manager.js";
import { safeJoin } from "../path-security.js";
import { runValidationCommands as defaultRunValidationCommands } from "../validation-runner.js";
import { collectWorktreeDiff as defaultCollectWorktreeDiff } from "../worktree-diff-collector.js";
import {
  commitChanges as defaultCommitChanges,
  openPullRequest as defaultOpenPullRequest,
  pushBranch as defaultPushBranch
} from "../implementation-git-actions.js";
import {
  buildImplementationReportJson as defaultBuildImplementationReportJson,
  buildImplementationReportMarkdown as defaultBuildImplementationReportMarkdown
} from "../implementation-report-builder.js";
import { jiraIssueContextFrom } from "../jira-issue-context.js";
import type {
  CommitChangesArtifact,
  Invocation,
  PullRequestArtifact,
  PushBranchArtifact,
  ValidationResult
} from "../types.js";
import type { WorktreeDiff } from "../worktree-diff-collector.js";
import { defineBuiltInStep } from "./registry.js";
import {
  expectedRemoteUrlsFrom,
  finalValidationFrom,
  implementationWorkspaceFrom,
  jiraIssueInvocationFrom,
  repositoryFrom,
  requiredImplementationFrom,
  resolvedInput,
  runIdFrom,
  stepValue,
  workspaceFrom,
  workspaceRootFrom
} from "./state.js";

function implementationTitle(invocation: Invocation): string {
  const task = jiraIssueContextFrom(invocation);

  return `${task.issueKey}: ${task.title ?? task.issueKey}`;
}

function implementationReportStatus({
  validation,
  commit,
  push,
  pullRequest
}: {
  validation: ValidationResult;
  commit: CommitChangesArtifact;
  push: PushBranchArtifact;
  pullRequest: PullRequestArtifact;
}): string {
  if (!validation.passed) {
    return "validation_failed";
  }

  if (!commit.skipped && !push.skipped && !pullRequest.skipped) {
    return "ready_for_pr";
  }

  return "completed_with_skips";
}

export const prepareImplementationWorktreeBuiltIn = defineBuiltInStep({
  name: "prepare_implementation_worktree",
  metadata: {
    capturesWorkspace: true,
    locks: [{ resource: "repository", mode: "exclusive" }]
  },
  async run({ state, dependencies = {} }) {
    const prepareImplementationWorktree =
      dependencies.prepareImplementationWorktree ??
      defaultPrepareImplementationWorktree;
    const implementation = requiredImplementationFrom(state);
    const task = jiraIssueContextFrom(jiraIssueInvocationFrom(state));

    return await prepareImplementationWorktree({
      subject: {
        key: task.issueKey,
        title: task.title
      },
      repository: repositoryFrom(state),
      workspaceRoot: workspaceRootFrom(state),
      runId: runIdFrom(state),
      baseRef: implementation.pull_request.base_ref,
      branchPattern: implementation.branch_pattern
    });
  }
});

export const collectTaskContextBuiltIn = defineBuiltInStep({
  name: "collect_task_context",
  run({ state }) {
    const task = jiraIssueContextFrom(jiraIssueInvocationFrom(state));

    return {
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

export const runValidationCommandsBuiltIn = defineBuiltInStep({
  name: "run_validation_commands",
  async run({ state, dependencies = {} }) {
    const runValidationCommands =
      dependencies.runValidationCommands ?? defaultRunValidationCommands;
    const implementation = requiredImplementationFrom(state);

    return await runValidationCommands({
      cwd: workspaceFrom(state).path,
      commands: implementation.validation.commands,
      maxOutputBytes: implementation.validation.max_output_bytes
    });
  }
});

export const collectWorktreeDiffBuiltIn = defineBuiltInStep({
  name: "collect_worktree_diff",
  async run({ state, dependencies = {} }) {
    const collectWorktreeDiff =
      dependencies.collectWorktreeDiff ?? defaultCollectWorktreeDiff;
    const implementation = requiredImplementationFrom(state);

    return await collectWorktreeDiff({
      cwd: workspaceFrom(state).path,
      maxDiffBytes: implementation.validation.max_output_bytes
    });
  }
});

export const commitChangesBuiltIn = defineBuiltInStep({
  name: "commit_changes",
  metadata: { locks: [{ resource: "repository", mode: "exclusive" }] },
  async run({ state, input, dependencies = {} }) {
    const commitChanges = dependencies.commitChanges ?? defaultCommitChanges;
    const resolved = resolvedInput(input, state);
    const implementation = requiredImplementationFrom(state);
    const repository = repositoryFrom(state);
    const workspace = implementationWorkspaceFrom(state);
    const invocation = jiraIssueInvocationFrom(state);
    const runId = runIdFrom(state);

    return await commitChanges({
      enabled: implementation.commit.enabled,
      cwd: workspace.path,
      validation: finalValidationFrom(state, resolved),
      acceptance: stepValue(state, resolved, "acceptance", "acceptance"),
      diff: stepValue<WorktreeDiff>(state, resolved, "diff", "worktree_diff"),
      branch: workspace.branch,
      remote: implementation.push.remote,
      baseSha: workspace.base_sha,
      branchPattern: implementation.branch_pattern,
      expectedRemoteUrls: expectedRemoteUrlsFrom(repository),
      message: implementationTitle(invocation),
      runId,
      repositoryPath: repository.path,
      journalPath: await safeJoin(workspaceRootFrom(state), [
        repository.id,
        `${runId}.transactions.jsonl`
      ])
    });
  }
});

export const pushBranchBuiltIn = defineBuiltInStep({
  name: "push_branch",
  metadata: { locks: [{ resource: "repository", mode: "exclusive" }] },
  async run({ state, input, dependencies = {} }) {
    const pushBranch = dependencies.pushBranch ?? defaultPushBranch;
    const resolved = resolvedInput(input, state);
    const implementation = requiredImplementationFrom(state);
    const repository = repositoryFrom(state);
    const workspace = implementationWorkspaceFrom(state);

    return await pushBranch({
      enabled: implementation.push.enabled,
      cwd: workspace.path,
      commit: stepValue<CommitChangesArtifact>(state, resolved, "commit", "commit"),
      branch: workspace.branch,
      remote: implementation.push.remote,
      expectedRemoteUrls: expectedRemoteUrlsFrom(repository)
    });
  }
});

export const openPullRequestBuiltIn = defineBuiltInStep({
  name: "open_pull_request",
  metadata: { locks: [{ resource: "repository", mode: "exclusive" }] },
  async run({ state, input, dependencies = {} }) {
    const openPullRequest = dependencies.openPullRequest ?? defaultOpenPullRequest;
    const resolved = resolvedInput(input, state);
    const implementation = requiredImplementationFrom(state);
    const workspace = implementationWorkspaceFrom(state);
    const invocation = jiraIssueInvocationFrom(state);
    const task = jiraIssueContextFrom(invocation);

    return await openPullRequest({
      enabled: implementation.pull_request.enabled,
      cwd: workspace.path,
      push: stepValue<PushBranchArtifact>(state, resolved, "push", "push"),
      branch: workspace.branch,
      provider: implementation.pull_request.provider,
      baseRef: implementation.pull_request.base_ref,
      draft: implementation.pull_request.draft,
      title: implementationTitle(invocation),
      body: task.description
    });
  }
});

export const finalImplementationReportBuiltIn = defineBuiltInStep({
  name: "final_implementation_report",
  metadata: { deferUntilAfterWorkspaceLifecycle: true },
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
    const pullRequest = stepValue<PullRequestArtifact>(
      state,
      resolved,
      "pull_request",
      "pull_request"
    );
    const reportInput = {
      invocation: jiraIssueInvocationFrom(state),
      status: implementationReportStatus({
        validation,
        commit,
        push,
        pullRequest
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
      pullRequest,
      trustedHostLocal:
        requiredImplementationFrom(state).sandbox.type === "trusted_host_local"
    };

    return {
      json: buildImplementationReportJson(reportInput),
      markdown: buildImplementationReportMarkdown(reportInput)
    };
  }
});
