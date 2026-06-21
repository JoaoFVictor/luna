import type {
  AcceptanceDecision,
  CommitChangesArtifact,
  Finding,
  ImplementationConfig,
  Invocation,
  PullRequestArtifact,
  PushBranchArtifact,
  RepoContext,
  RepositoryConfig,
  ValidationResult,
  WorkspaceRecord
} from "../types.js";
import type { ImplementationWorktreeRecord } from "../implementation-worktree-manager.js";
import type { WorktreeDiff } from "../worktree-diff-collector.js";
import type { WorkflowState } from "../workflow-state.js";

export type MaybePromise<T> = T | Promise<T>;

export type BuiltInStepMetadata = {
  readonly deferUntilAfterWorkspaceLifecycle?: boolean;
  readonly capturesWorkspace?: boolean;
  readonly locks?: readonly {
    readonly resource: "repository";
    readonly mode: "exclusive";
  }[];
};

export type BuiltInStepRunOptions = {
  readonly state: WorkflowState;
  readonly input?: Record<string, unknown>;
  readonly dependencies?: BuiltInStepDependencies;
};

export type BuiltInStep<Name extends string = string> = {
  readonly name: Name;
  readonly metadata?: BuiltInStepMetadata;
  readonly run: (options: BuiltInStepRunOptions) => MaybePromise<unknown>;
};

export type RunBuiltInStepOptions = BuiltInStepRunOptions & {
  uses: string;
};

export type BuiltInStepDependencies = {
  runPreflight?: (input: {
    invocation: Invocation;
    repository: RepositoryConfig;
    workflow?: { mode: "git_managed_read_only" | "git_managed_write" };
    implementation?: ImplementationConfig["implementation"];
  }) => MaybePromise<unknown>;
  prepareWorktree?: (input: {
    invocation: Invocation;
    repository: RepositoryConfig;
    workspaceRoot: string;
    runId: string;
  }) => MaybePromise<WorkspaceRecord>;
  collectRepoContext?: (input: {
    repository: RepositoryConfig;
    baseSha: string;
    headSha: string;
  }) => MaybePromise<RepoContext>;
  validateFindingEvidence?: (
    repoContext: RepoContext,
    findings: readonly Finding[]
  ) => Finding[];
  buildFinalReportJson?: (input: {
    acceptance: AcceptanceDecision;
    findings: readonly Finding[];
    workspace?: WorkspaceRecord;
  }) => unknown;
  buildFinalReportMarkdown?: (input: {
    invocation: Invocation;
    findings: readonly Finding[];
    acceptance: AcceptanceDecision;
  }) => string;
  prepareImplementationWorktree?: (input: {
    subject: {
      key: string;
      title?: string;
    };
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
    runId?: string;
    repositoryPath?: string;
    journalPath?: string;
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
    baseRef?: string;
    draft: boolean;
    title: string;
    body?: string;
  }) => MaybePromise<PullRequestArtifact>;
  buildImplementationReportJson?: (input: {
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
    pullRequest: PullRequestArtifact;
    trustedHostLocal: boolean;
  }) => unknown;
  buildImplementationReportMarkdown?: (input: {
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
    pullRequest: PullRequestArtifact;
    trustedHostLocal: boolean;
  }) => string;
};
