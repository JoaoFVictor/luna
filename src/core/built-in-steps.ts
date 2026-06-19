import {
  buildFinalReportJson as defaultBuildFinalReportJson,
  buildFinalReportMarkdown as defaultBuildFinalReportMarkdown
} from "./report-builder.js";
import { prepare as defaultPrepareWorktree } from "./git-worktree-manager.js";
import {
  prepareImplementationWorktree as defaultPrepareImplementationWorktree,
  type ImplementationWorktreeRecord
} from "./implementation-worktree-manager.js";
import { collectRepoContext as defaultCollectRepoContext } from "./repo-context-collector.js";
import { runValidationCommands as defaultRunValidationCommands } from "./validation-runner.js";
import {
  collectWorktreeDiff as defaultCollectWorktreeDiff,
  type WorktreeDiff
} from "./worktree-diff-collector.js";
import {
  commitChanges as defaultCommitChanges,
  openPullRequest as defaultOpenPullRequest,
  pushBranch as defaultPushBranch
} from "./implementation-git-actions.js";
import {
  buildImplementationReportJson as defaultBuildImplementationReportJson,
  buildImplementationReportMarkdown as defaultBuildImplementationReportMarkdown
} from "./implementation-report-builder.js";
import { runPreflight as defaultRunPreflight } from "./preflight.js";
import { validateFindingEvidence as defaultValidateFindingEvidence } from "./evidence-validator.js";
import { resolveWorkflowInput, type WorkflowState } from "./workflow-state.js";
import type {
  AcceptanceDecision,
  CodeReviewFindings,
  CommitChangesArtifact,
  Finding,
  GithubPrInvocation,
  ImplementationConfig,
  Invocation,
  JiraTaskInvocation,
  PullRequestArtifact,
  PushBranchArtifact,
  RepoContext,
  RepositoryConfig,
  ValidationResult,
  WorkspaceRecord
} from "./types.js";

export type BuiltInStepName =
  | "preflight"
  | "prepare_worktree"
  | "collect_repo_context"
  | "validate_code_review_findings"
  | "final_code_review_report"
  | "prepare_implementation_worktree"
  | "collect_task_context"
  | "run_validation_commands"
  | "collect_worktree_diff"
  | "commit_changes"
  | "push_branch"
  | "open_pull_request"
  | "final_implementation_report";

type MaybePromise<T> = T | Promise<T>;

export type BuiltInStepDependencies = {
  runPreflight?: (input: {
    invocation: Invocation;
    repository: RepositoryConfig;
    workflow?: { mode: "git_managed_read_only" | "git_managed_write" };
    implementation?: ImplementationConfig["implementation"];
  }) => MaybePromise<unknown>;
  prepareWorktree?: (input: {
    invocation: GithubPrInvocation;
    repository: RepositoryConfig;
    workspaceRoot: string;
    runId: string;
  }) => MaybePromise<WorkspaceRecord>;
  collectRepoContext?: (input: {
    invocation: GithubPrInvocation;
    repository: RepositoryConfig;
  }) => MaybePromise<RepoContext>;
  validateFindingEvidence?: (
    repoContext: RepoContext,
    findings: readonly Finding[]
  ) => Finding[];
  buildFinalReportJson?: (input: {
    acceptance: AcceptanceDecision;
    findings: readonly Finding[];
    reportPath: string;
    workspace?: WorkspaceRecord;
  }) => unknown;
  buildFinalReportMarkdown?: (input: {
    invocation: GithubPrInvocation;
    findings: readonly Finding[];
    acceptance: AcceptanceDecision;
  }) => string;
  prepareImplementationWorktree?: (input: {
    invocation: JiraTaskInvocation;
    repository: RepositoryConfig;
    workspaceRoot: string;
    runId: string;
    baseRef: string;
    branchPattern: string;
  }) => MaybePromise<ImplementationWorktreeRecord>;
  runValidationCommands?: (input: {
    cwd: string;
    commands: ImplementationConfig["implementation"]["validation"]["commands"];
    maxOutputBytes: number;
  }) => MaybePromise<ValidationResult>;
  collectWorktreeDiff?: (input: {
    cwd: string;
    maxDiffBytes: number;
  }) => MaybePromise<WorktreeDiff>;
  commitChanges?: (input: {
    enabled: boolean;
    cwd: string;
    validation: ValidationResult;
    acceptance: unknown;
    diff: WorktreeDiff;
    branch: string;
    remote: string;
    baseSha: string;
    branchPattern: string;
    expectedRemoteUrls: readonly string[];
    message: string;
  }) => MaybePromise<CommitChangesArtifact>;
  pushBranch?: (input: {
    enabled: boolean;
    cwd: string;
    commit: CommitChangesArtifact;
    branch: string;
    remote: string;
    expectedRemoteUrls: readonly string[];
  }) => MaybePromise<PushBranchArtifact>;
  openPullRequest?: (input: {
    enabled: boolean;
    cwd: string;
    push: PushBranchArtifact;
    branch: string;
    provider: string;
    baseRef?: string;
    draft: boolean;
    title: string;
    body?: string;
  }) => MaybePromise<PullRequestArtifact>;
  buildImplementationReportJson?: (input: {
    invocation: JiraTaskInvocation;
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
    pullRequest: PullRequestArtifact;
    trustedHostLocal: boolean;
  }) => unknown;
  buildImplementationReportMarkdown?: (input: {
    invocation: JiraTaskInvocation;
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
    pullRequest: PullRequestArtifact;
    trustedHostLocal: boolean;
  }) => string;
};

export type RunBuiltInStepOptions = {
  uses: BuiltInStepName;
  state: WorkflowState;
  input?: Record<string, unknown>;
  dependencies?: BuiltInStepDependencies;
};

type BuiltInErrorCode =
  | "built_in_input_missing"
  | "built_in_state_missing"
  | "built_in_unsupported";

function builtInError(message: string, code: BuiltInErrorCode): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;

  return error;
}

function requiredState<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw builtInError(`Built-in step requires state.${name}`, "built_in_state_missing");
  }

  return value;
}

function requiredInput<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw builtInError(`Built-in step requires input.${name}`, "built_in_input_missing");
  }

  return value;
}

function asRecord(value: unknown, name: string, code: BuiltInErrorCode): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw builtInError(`Built-in step requires ${name}`, code);
  }

  return value as Record<string, unknown>;
}

function githubPrInvocationFrom(state: WorkflowState): GithubPrInvocation {
  const invocation = requiredState(
    state.invocation as Invocation | undefined,
    "invocation"
  );

  if (invocation.target !== "github_pr") {
    throw builtInError(
      `Built-in step requires github_pr invocation: ${invocation.target}`,
      "built_in_unsupported"
    );
  }

  return invocation;
}

function jiraTaskInvocationFrom(state: WorkflowState): JiraTaskInvocation {
  const invocation = requiredState(
    state.invocation as Invocation | undefined,
    "invocation"
  );

  if (invocation.target !== "jira_task") {
    throw builtInError(
      `Built-in step requires jira_task invocation: ${invocation.target}`,
      "built_in_unsupported"
    );
  }

  return invocation;
}

function repositoryFrom(state: WorkflowState): RepositoryConfig {
  return requiredState(state.repository as RepositoryConfig | undefined, "repository");
}

function workflowFrom(
  state: WorkflowState
): { mode: "git_managed_read_only" | "git_managed_write" } | undefined {
  const workflow = state.workflow as { mode?: unknown } | undefined;

  if (
    workflow?.mode === "git_managed_read_only" ||
    workflow?.mode === "git_managed_write"
  ) {
    return { mode: workflow.mode };
  }

  return undefined;
}

function implementationFrom(
  state: WorkflowState
): ImplementationConfig["implementation"] | undefined {
  return (
    state.config as
      | { implementation?: ImplementationConfig["implementation"] }
      | undefined
  )?.implementation;
}

function requiredImplementationFrom(
  state: WorkflowState
): ImplementationConfig["implementation"] {
  return requiredState(implementationFrom(state), "config.implementation");
}

function runIdFrom(state: WorkflowState): string {
  const run = asRecord(requiredState(state.run, "run"), "state.run", "built_in_state_missing");
  return requiredState(run.run_id as string | undefined, "run.run_id");
}

function workspaceFrom(state: WorkflowState): WorkspaceRecord {
  return requiredState(state.workspace as WorkspaceRecord | undefined, "workspace");
}

function implementationWorkspaceFrom(state: WorkflowState): ImplementationWorktreeRecord {
  const workspace = workspaceFrom(state) as Partial<ImplementationWorktreeRecord>;

  requiredState(workspace.branch, "workspace.branch");
  requiredState(workspace.remote, "workspace.remote");
  requiredState(workspace.base_sha, "workspace.base_sha");

  return workspace as ImplementationWorktreeRecord;
}

function workspaceRootFrom(state: WorkflowState): string {
  return requiredState(state.workspaceRoot, "workspaceRoot");
}

function reportPathFrom(state: WorkflowState): string {
  return requiredState(state.reportPath, "reportPath");
}

function findingsFrom(value: unknown): readonly Finding[] {
  if (Array.isArray(value)) {
    return value as Finding[];
  }

  return requiredInput((value as CodeReviewFindings | undefined)?.findings, "findings.findings");
}

function resolvedInput(
  input: Record<string, unknown> | undefined,
  state: WorkflowState
): Record<string, unknown> {
  return resolveWorkflowInput(input, state);
}

function optionalResolvedOrStep(
  resolved: Record<string, unknown>,
  state: WorkflowState,
  inputName: string,
  stepName: string
): unknown {
  if (resolved[inputName] !== undefined) {
    return resolved[inputName];
  }

  return (state.steps as Record<string, unknown> | undefined)?.[stepName];
}

function finalValidationFrom(
  state: WorkflowState,
  resolved: Record<string, unknown> = {}
): ValidationResult {
  const direct = optionalResolvedOrStep(resolved, state, "validation", "validation");

  if (direct !== undefined) {
    return direct as ValidationResult;
  }

  const implementation = asRecord(
    requiredState(
      (state.steps as Record<string, unknown> | undefined)?.implementation,
      "steps.implementation"
    ),
    "state.steps.implementation",
    "built_in_state_missing"
  );

  return requiredState(
    implementation.final_validation as ValidationResult | undefined,
    "steps.implementation.final_validation"
  );
}

function stepValue<T>(
  state: WorkflowState,
  resolved: Record<string, unknown>,
  inputName: string,
  stepName: string
): T {
  return requiredState(
    optionalResolvedOrStep(resolved, state, inputName, stepName) as T | undefined,
    `steps.${stepName}`
  );
}

function expectedRemoteUrlsFrom(repository: RepositoryConfig): readonly string[] {
  return requiredState(
    repository.expected_remote_urls,
    "repository.expected_remote_urls"
  );
}

function implementationTitle(invocation: JiraTaskInvocation): string {
  return `${invocation.jira.issue_key}: ${invocation.jira.summary}`;
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

export async function runBuiltInStep({
  uses,
  state,
  input,
  dependencies = {}
}: RunBuiltInStepOptions): Promise<unknown> {
  if (uses === "preflight") {
    const runPreflight = dependencies.runPreflight ?? defaultRunPreflight;

    return await runPreflight({
      invocation: requiredState(
        state.invocation as Invocation | undefined,
        "invocation"
      ),
      repository: repositoryFrom(state),
      workflow: workflowFrom(state),
      implementation: implementationFrom(state)
    });
  }

  if (uses === "prepare_worktree") {
    const prepareWorktree = dependencies.prepareWorktree ?? defaultPrepareWorktree;
    const runId = runIdFrom(state);

    return await prepareWorktree({
      invocation: githubPrInvocationFrom(state),
      repository: repositoryFrom(state),
      workspaceRoot: workspaceRootFrom(state),
      runId
    });
  }

  if (uses === "collect_repo_context") {
    const collectRepoContext = dependencies.collectRepoContext ?? defaultCollectRepoContext;
    const workspace = workspaceFrom(state);

    return await collectRepoContext({
      invocation: githubPrInvocationFrom(state),
      repository: {
        ...repositoryFrom(state),
        path: workspace.path
      }
    });
  }

  if (uses === "validate_code_review_findings") {
    const validateFindingEvidence =
      dependencies.validateFindingEvidence ?? defaultValidateFindingEvidence;
    const resolved = resolvedInput(input, state);
    const repoContext = requiredInput(
      resolved.repo_context as RepoContext | undefined,
      "repo_context"
    );
    const findingsPayload = requiredInput(resolved.findings, "findings");
    const findings = findingsFrom(findingsPayload);

    return {
      ...(typeof findingsPayload === "object" &&
      findingsPayload !== null &&
      !Array.isArray(findingsPayload) &&
      typeof (findingsPayload as CodeReviewFindings).summary === "string"
        ? { summary: (findingsPayload as CodeReviewFindings).summary }
        : {}),
      findings: validateFindingEvidence(repoContext, findings)
    };
  }

  if (uses === "final_code_review_report") {
    const buildFinalReportJson =
      dependencies.buildFinalReportJson ?? defaultBuildFinalReportJson;
    const buildFinalReportMarkdown =
      dependencies.buildFinalReportMarkdown ?? defaultBuildFinalReportMarkdown;
    const resolved = resolvedInput(input, state);
    const findings = findingsFrom(requiredInput(resolved.findings, "findings"));
    const acceptance = requiredInput(
      resolved.acceptance as AcceptanceDecision | undefined,
      "acceptance"
    );
    const reportPath = reportPathFrom(state);

    return {
      json: buildFinalReportJson({
        acceptance,
        findings,
        reportPath,
        workspace: state.workspace as WorkspaceRecord | undefined
      }),
      markdown: buildFinalReportMarkdown({
        invocation: githubPrInvocationFrom(state),
        findings,
        acceptance
      })
    };
  }

  if (uses === "prepare_implementation_worktree") {
    const prepareImplementationWorktree =
      dependencies.prepareImplementationWorktree ??
      defaultPrepareImplementationWorktree;
    const implementation = requiredImplementationFrom(state);

    return await prepareImplementationWorktree({
      invocation: jiraTaskInvocationFrom(state),
      repository: repositoryFrom(state),
      workspaceRoot: workspaceRootFrom(state),
      runId: runIdFrom(state),
      baseRef: implementation.pull_request.base_ref,
      branchPattern: implementation.branch_pattern
    });
  }

  if (uses === "collect_task_context") {
    const invocation = jiraTaskInvocationFrom(state);

    return {
      jira: {
        issue_key: invocation.jira.issue_key,
        summary: invocation.jira.summary,
        description: invocation.jira.description,
        acceptance_criteria: invocation.jira.acceptance_criteria
      },
      repository: invocation.repository
    };
  }

  if (uses === "run_validation_commands") {
    const runValidationCommands =
      dependencies.runValidationCommands ?? defaultRunValidationCommands;
    const implementation = requiredImplementationFrom(state);

    return await runValidationCommands({
      cwd: workspaceFrom(state).path,
      commands: implementation.validation.commands,
      maxOutputBytes: implementation.validation.max_output_bytes
    });
  }

  if (uses === "collect_worktree_diff") {
    const collectWorktreeDiff =
      dependencies.collectWorktreeDiff ?? defaultCollectWorktreeDiff;
    const implementation = requiredImplementationFrom(state);

    return await collectWorktreeDiff({
      cwd: workspaceFrom(state).path,
      maxDiffBytes: implementation.validation.max_output_bytes
    });
  }

  if (uses === "commit_changes") {
    const commitChanges = dependencies.commitChanges ?? defaultCommitChanges;
    const resolved = resolvedInput(input, state);
    const implementation = requiredImplementationFrom(state);
    const repository = repositoryFrom(state);
    const workspace = implementationWorkspaceFrom(state);
    const invocation = jiraTaskInvocationFrom(state);

    return await commitChanges({
      enabled: implementation.commit.enabled,
      cwd: workspace.path,
      validation: finalValidationFrom(state, resolved),
      acceptance: stepValue(state, resolved, "acceptance", "acceptance"),
      diff: stepValue(state, resolved, "diff", "worktree_diff"),
      branch: workspace.branch,
      remote: implementation.push.remote,
      baseSha: workspace.base_sha,
      branchPattern: implementation.branch_pattern,
      expectedRemoteUrls: expectedRemoteUrlsFrom(repository),
      message: implementationTitle(invocation)
    });
  }

  if (uses === "push_branch") {
    const pushBranch = dependencies.pushBranch ?? defaultPushBranch;
    const resolved = resolvedInput(input, state);
    const implementation = requiredImplementationFrom(state);
    const repository = repositoryFrom(state);
    const workspace = implementationWorkspaceFrom(state);

    return await pushBranch({
      enabled: implementation.push.enabled,
      cwd: workspace.path,
      commit: stepValue(state, resolved, "commit", "commit"),
      branch: workspace.branch,
      remote: implementation.push.remote,
      expectedRemoteUrls: expectedRemoteUrlsFrom(repository)
    });
  }

  if (uses === "open_pull_request") {
    const openPullRequest = dependencies.openPullRequest ?? defaultOpenPullRequest;
    const resolved = resolvedInput(input, state);
    const implementation = requiredImplementationFrom(state);
    const workspace = implementationWorkspaceFrom(state);
    const invocation = jiraTaskInvocationFrom(state);

    return await openPullRequest({
      enabled: implementation.pull_request.enabled,
      cwd: workspace.path,
      push: stepValue(state, resolved, "push", "push"),
      branch: workspace.branch,
      provider: implementation.pull_request.provider,
      baseRef: implementation.pull_request.base_ref,
      draft: implementation.pull_request.draft,
      title: implementationTitle(invocation),
      body: invocation.jira.description
    });
  }

  if (uses === "final_implementation_report") {
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
      invocation: jiraTaskInvocationFrom(state),
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

  throw builtInError(`Unsupported built-in step: ${uses}`, "built_in_unsupported");
}
