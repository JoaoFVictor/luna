import {
  mkdir as fsMkdir,
  realpath as fsRealpath
} from "node:fs/promises";
import path from "node:path";
import { runGit as defaultRunGit } from "./git.js";
import { isInsideRoot, safeJoin } from "./path-security.js";
import type { Invocation, RepositoryConfig, WorkspaceRecord } from "./types.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;
type Mkdir = (
  path: string,
  options: { recursive: boolean; mode: number }
) => Promise<unknown>;
type Realpath = (path: string) => Promise<string>;

type WorktreeErrorCode =
  | "head_sha_mismatch"
  | "path_security_violation"
  | "workspace_record_missing"
  | "workspace_record_mismatch";

type WorktreeError = Error & {
  code: WorktreeErrorCode;
};

type ChildProcessFailure = {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
  stderr?: unknown;
};

function worktreeError(message: string, code: WorktreeErrorCode): WorktreeError {
  const error = new Error(message) as WorktreeError;
  error.code = code;

  return error;
}

function isMissingCommitError(cause: unknown): boolean {
  const childProcessFailure = (cause as { cause?: ChildProcessFailure }).cause;
  const stderr =
    typeof childProcessFailure?.stderr === "string"
      ? childProcessFailure.stderr
      : "";

  return (
    (childProcessFailure?.code === 1 ||
      (childProcessFailure?.code === 128 &&
        stderr.includes("Not a valid object name"))) &&
    childProcessFailure.killed !== true &&
    childProcessFailure.signal === null
  );
}

function pullHeadRef(invocation: Invocation, remote: string): string {
  return `+refs/pull/${invocation.pull_number}/head:refs/remotes/${remote}/pull/${invocation.pull_number}/head`;
}

function fetchedPullHeadRef(invocation: Invocation, remote: string): string {
  return `refs/remotes/${remote}/pull/${invocation.pull_number}/head`;
}

function assertWorkspaceRecordMatches(
  workspaceRecord: WorkspaceRecord,
  persistedWorkspaceRecord?: WorkspaceRecord
): void {
  if (persistedWorkspaceRecord === undefined) {
    throw worktreeError(
      "Persisted workspace record is missing",
      "workspace_record_missing"
    );
  }

  if (
    persistedWorkspaceRecord.path !== workspaceRecord.path ||
    persistedWorkspaceRecord.run_id !== workspaceRecord.run_id ||
    persistedWorkspaceRecord.preserved !== workspaceRecord.preserved ||
    persistedWorkspaceRecord.reason !== workspaceRecord.reason
  ) {
    throw worktreeError(
      "Persisted workspace record does not match in-memory workspace record",
      "workspace_record_mismatch"
    );
  }
}

async function assertWorkspacePathInsideRoot(
  workspaceRoot: string,
  workspacePath: string,
  realpath: Realpath
): Promise<void> {
  if (!isInsideRoot(path.resolve(workspaceRoot), path.resolve(workspacePath))) {
    throw worktreeError(
      `Workspace path is outside workspace root: ${workspacePath}`,
      "path_security_violation"
    );
  }

  const rootReal = await realpath(workspaceRoot);
  const workspaceReal = await realpath(workspacePath);

  if (!isInsideRoot(rootReal, workspaceReal)) {
    throw worktreeError(
      `Workspace path is outside workspace root: ${workspacePath}`,
      "path_security_violation"
    );
  }
}

function assertRegisteredWorktree(
  workspaceRecord: WorkspaceRecord,
  worktreeList: string
): void {
  const registered = worktreeList
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .some((registeredPath) => registeredPath === workspaceRecord.path);

  if (!registered) {
    throw worktreeError(
      "Workspace path is not registered as a Git worktree",
      "workspace_record_missing"
    );
  }
}

export async function prepare({
  invocation,
  repository,
  workspaceRoot,
  runId,
  runGit = defaultRunGit,
  mkdir = fsMkdir
}: {
  invocation: Invocation;
  repository: RepositoryConfig;
  workspaceRoot: string;
  runId: string;
  runGit?: RunGit;
  mkdir?: Mkdir;
}): Promise<WorkspaceRecord> {
  const worktreePath = await safeJoin(workspaceRoot, [repository.id, runId]);

  await mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
  await runGit(repository.path, ["fetch", repository.remote, invocation.base_ref]);
  await runGit(repository.path, [
    "fetch",
    repository.remote,
    pullHeadRef(invocation, repository.remote)
  ]);
  await runGit(repository.path, [
    "cat-file",
    "-e",
    `${invocation.references.base_sha}^{commit}`
  ]);
  try {
    await runGit(repository.path, [
      "cat-file",
      "-e",
      `${invocation.references.head_sha}^{commit}`
    ]);
  } catch (cause) {
    if (!isMissingCommitError(cause)) {
      throw cause;
    }

    const error = worktreeError(
      `Expected head commit is missing: ${invocation.references.head_sha}`,
      "head_sha_mismatch"
    );
    error.cause = cause;
    throw error;
  }
  await runGit(repository.path, [
    "worktree",
    "add",
    worktreePath,
    fetchedPullHeadRef(invocation, repository.remote)
  ]);

  const actualHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
  if (actualHead !== invocation.references.head_sha) {
    let cleanupCause: unknown;

    try {
      await runGit(repository.path, ["worktree", "remove", worktreePath]);
    } catch (cause) {
      cleanupCause = cause;
    }

    const message =
      cleanupCause === undefined
        ? `Worktree HEAD ${actualHead} did not match expected ${invocation.references.head_sha}`
        : `Worktree HEAD ${actualHead} did not match expected ${invocation.references.head_sha}; cleanup failed`;
    const error = worktreeError(message, "head_sha_mismatch");
    if (cleanupCause !== undefined) {
      error.cause = cleanupCause;
    }

    throw error;
  }

  return {
    run_id: runId,
    path: worktreePath,
    preserved: true,
    reason: "created"
  };
}

export async function cleanup({
  repositoryPath,
  workspaceRoot,
  workspaceRecord,
  persistedWorkspaceRecord,
  runGit = defaultRunGit,
  realpath = fsRealpath
}: {
  repositoryPath: string;
  workspaceRoot: string;
  workspaceRecord: WorkspaceRecord;
  persistedWorkspaceRecord?: WorkspaceRecord;
  runGit?: RunGit;
  realpath?: Realpath;
}): Promise<WorkspaceRecord> {
  assertWorkspaceRecordMatches(workspaceRecord, persistedWorkspaceRecord);
  await assertWorkspacePathInsideRoot(workspaceRoot, workspaceRecord.path, realpath);

  const worktreeList = await runGit(repositoryPath, [
    "worktree",
    "list",
    "--porcelain"
  ]);
  assertRegisteredWorktree(workspaceRecord, worktreeList);

  await runGit(repositoryPath, ["worktree", "remove", workspaceRecord.path]);

  return {
    ...workspaceRecord,
    preserved: false,
    reason: "success_cleanup"
  };
}
