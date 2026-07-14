import type { RepositoryWorkspaceRecord } from "../repository-workspace/contracts.js";
import type { ApprovedWorktreeSnapshot } from "./worktree-snapshot.js";

export type GitStatusOperationId = "git.status";
export type GitCommitOperationId = "git.commit";
export type GitPushBranchOperationId = "git.push_branch";

export type GitOperationId =
  | GitStatusOperationId
  | GitCommitOperationId
  | GitPushBranchOperationId;

export type GitStatusInput = {
  readonly operation_id: GitStatusOperationId;
  readonly workspace: RepositoryWorkspaceRecord;
};

export type GitCommitInput = {
  readonly operation_id: GitCommitOperationId;
  readonly workspace: RepositoryWorkspaceRecord;
  readonly message: string;
  readonly paths?: readonly string[];
  readonly expected_branch?: string;
  readonly expected_head_sha?: string;
  readonly expected_base_sha?: string;
  readonly expected_dirty_paths?: readonly string[];
  readonly expected_snapshot?: ApprovedWorktreeSnapshot;
  readonly remote?: string;
  readonly expected_remote_urls?: readonly string[];
};

export type GitCommitSkippedInput = {
  readonly operation_id?: GitCommitOperationId;
  readonly enabled: boolean;
  readonly skipped: true;
  readonly reason: string;
};

export type GitPushBranchInput = {
  readonly operation_id: GitPushBranchOperationId;
  readonly workspace: RepositoryWorkspaceRecord;
  readonly branch: string;
  readonly remote: string;
  readonly expected_commit_sha: string;
  readonly expected_remote_urls?: readonly string[];
};

export type GitPushBranchSkippedInput = {
  readonly operation_id?: GitPushBranchOperationId;
  readonly enabled: boolean;
  readonly skipped: true;
  readonly reason: string;
};

export type GitStatusResult = {
  readonly operation_id: GitStatusOperationId;
  readonly workspace_id: string;
  readonly branch: string;
  readonly head_sha: string;
  readonly dirty: boolean;
  readonly staged_paths: readonly string[];
  readonly unstaged_paths: readonly string[];
  readonly untracked_paths: readonly string[];
};

export type GitCommitState = {
  readonly operation_id: GitCommitOperationId;
  readonly workspace_id: string;
  readonly branch: string;
  readonly head_sha: string;
  readonly commit_sha?: string;
  readonly message?: string;
  readonly paths?: readonly string[];
  readonly tree_oid?: string;
};

export type GitCommitResult = GitCommitState & {
  readonly commit_sha: string;
  readonly message: string;
  readonly adopted: boolean;
};

export type GitCommitSkippedResult = GitCommitSkippedInput & {
  readonly operation_id: GitCommitOperationId;
};

export type GitPushBranchResult = {
  readonly operation_id: GitPushBranchOperationId;
  readonly workspace_id: string;
  readonly branch: string;
  readonly remote: string;
  readonly commit_sha: string;
  readonly pushed: boolean;
};

export type GitPushBranchSkippedResult = GitPushBranchSkippedInput & {
  readonly operation_id: GitPushBranchOperationId;
};

export type GitRepositoryPort = {
  status(input: GitStatusInput): GitStatusResult | Promise<GitStatusResult>;
  readCommitState(
    input: GitCommitInput
  ): GitCommitState | undefined | Promise<GitCommitState | undefined>;
  commit(input: GitCommitInput): GitCommitResult | Promise<GitCommitResult>;
  pushBranch(
    input: GitPushBranchInput
  ): GitPushBranchResult | Promise<GitPushBranchResult>;
};

export type GitBuiltInPorts = {
  readonly repository: GitRepositoryPort;
};
