import { realpath as fsRealpath } from "node:fs/promises";
import path from "node:path";
import { runGit as defaultRunGit } from "../git/client.js";
import { isInsideRoot } from "../../core/security/path.js";
import type { WorkspaceRecord } from "./types.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;
type Realpath = (path: string) => Promise<string>;

type WorktreeErrorCode =
  | "path_security_violation"
  | "workspace_record_missing"
  | "workspace_record_mismatch";

type WorktreeError = Error & {
  code: WorktreeErrorCode;
};

function worktreeError(message: string, code: WorktreeErrorCode): WorktreeError {
  const error = new Error(message) as WorktreeError;
  error.code = code;

  return error;
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

function withCleanedNestedWorkspace<TWorkspaceRecord extends WorkspaceRecord>(
  workspaceRecord: TWorkspaceRecord,
  cleaned: TWorkspaceRecord
): TWorkspaceRecord {
  const nested = (workspaceRecord as { readonly workspace?: unknown }).workspace;
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    return cleaned;
  }

  return {
    ...cleaned,
    workspace: {
      ...nested,
      preserved: false,
      reason: "success_cleanup"
    }
  } as TWorkspaceRecord;
}

export async function cleanup<TWorkspaceRecord extends WorkspaceRecord>({
  repositoryPath,
  workspaceRoot,
  workspaceRecord,
  persistedWorkspaceRecord,
  runGit = defaultRunGit,
  realpath = fsRealpath
}: {
  repositoryPath: string;
  workspaceRoot: string;
  workspaceRecord: TWorkspaceRecord;
  persistedWorkspaceRecord?: WorkspaceRecord;
  runGit?: RunGit;
  realpath?: Realpath;
}): Promise<TWorkspaceRecord> {
  assertWorkspaceRecordMatches(workspaceRecord, persistedWorkspaceRecord);
  await assertWorkspacePathInsideRoot(workspaceRoot, workspaceRecord.path, realpath);

  const worktreeList = await runGit(repositoryPath, [
    "worktree",
    "list",
    "--porcelain"
  ]);
  assertRegisteredWorktree(workspaceRecord, worktreeList);

  await runGit(repositoryPath, ["worktree", "remove", workspaceRecord.path]);

  return withCleanedNestedWorkspace(workspaceRecord, {
    ...workspaceRecord,
    preserved: false,
    reason: "success_cleanup"
  });
}
