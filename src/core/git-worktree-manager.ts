import { mkdir as fsMkdir } from "node:fs/promises";
import path from "node:path";
import { runGit as defaultRunGit } from "./git.js";
import { safeJoin } from "./path-security.js";
import type { Invocation, RepositoryConfig, WorkspaceRecord } from "./types.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;
type Mkdir = (
  path: string,
  options: { recursive: boolean; mode: number }
) => Promise<unknown>;

type WorktreeErrorCode =
  | "head_sha_mismatch"
  | "path_security_violation"
  | "workspace_record_missing"
  | "workspace_record_mismatch";

type WorktreeError = Error & {
  code: WorktreeErrorCode;
};

type InvocationWithBaseRef = Invocation & {
  base_ref?: unknown;
};

function worktreeError(message: string, code: WorktreeErrorCode): WorktreeError {
  const error = new Error(message) as WorktreeError;
  error.code = code;

  return error;
}

function baseRef(invocation: InvocationWithBaseRef): string {
  if (typeof invocation.base_ref === "string" && invocation.base_ref !== "") {
    return invocation.base_ref;
  }

  return "main";
}

function pullHeadRef(invocation: Invocation, remote: string): string {
  return `+refs/pull/${invocation.pull_number}/head:refs/remotes/${remote}/pull/${invocation.pull_number}/head`;
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  const [firstSegment] = relative.split(path.sep);

  return relative === "" || (firstSegment !== ".." && !path.isAbsolute(relative));
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
    persistedWorkspaceRecord.preserved !== workspaceRecord.preserved
  ) {
    throw worktreeError(
      "Persisted workspace record does not match in-memory workspace record",
      "workspace_record_mismatch"
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
  invocation: InvocationWithBaseRef;
  repository: RepositoryConfig;
  workspaceRoot: string;
  runId: string;
  runGit?: RunGit;
  mkdir?: Mkdir;
}): Promise<WorkspaceRecord> {
  const worktreePath = await safeJoin(workspaceRoot, [repository.id, runId]);

  await mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
  await runGit(repository.path, ["fetch", repository.remote, baseRef(invocation)]);
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
  await runGit(repository.path, [
    "cat-file",
    "-e",
    `${invocation.references.head_sha}^{commit}`
  ]);
  await runGit(repository.path, [
    "worktree",
    "add",
    worktreePath,
    invocation.references.head_sha
  ]);

  const actualHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
  if (actualHead !== invocation.references.head_sha) {
    throw worktreeError(
      `Worktree HEAD ${actualHead} did not match expected ${invocation.references.head_sha}`,
      "head_sha_mismatch"
    );
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
  runGit = defaultRunGit
}: {
  repositoryPath: string;
  workspaceRoot: string;
  workspaceRecord: WorkspaceRecord;
  persistedWorkspaceRecord?: WorkspaceRecord;
  runGit?: RunGit;
}): Promise<WorkspaceRecord> {
  assertWorkspaceRecordMatches(workspaceRecord, persistedWorkspaceRecord);

  if (!isPathInsideRoot(workspaceRoot, workspaceRecord.path)) {
    throw worktreeError(
      `Workspace path is outside workspace root: ${workspaceRecord.path}`,
      "path_security_violation"
    );
  }

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
