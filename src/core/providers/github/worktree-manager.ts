import {
  mkdir as fsMkdir
} from "node:fs/promises";
import path from "node:path";
import { runGit as defaultRunGit } from "../../git/client.js";
import { safeJoin } from "../../path-security.js";
import type { Invocation } from "../../invocation/types.js";
import type { WorkspaceRecord } from "../../types.js";
import type { RepositoryConfig } from "../../config/schemas.js";
import { githubPullRequestContextFrom } from "./pull-request-context.js";

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
  cause?: unknown;
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

function pullHeadRef(pullNumber: number, remote: string): string {
  return `+refs/pull/${pullNumber}/head:refs/remotes/${remote}/pull/${pullNumber}/head`;
}

function fetchedPullHeadRef(pullNumber: number, remote: string): string {
  return `refs/remotes/${remote}/pull/${pullNumber}/head`;
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
  const pullRequest = githubPullRequestContextFrom(invocation);
  const { base_sha: baseSha, head_sha: headSha } = pullRequest.references;
  const worktreePath = await safeJoin(workspaceRoot, [repository.id, runId]);

  await mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
  await runGit(repository.path, ["fetch", repository.remote, pullRequest.base_ref]);
  await runGit(repository.path, [
    "fetch",
    repository.remote,
    pullHeadRef(pullRequest.pull_number, repository.remote)
  ]);
  await runGit(repository.path, [
    "cat-file",
    "-e",
    `${baseSha}^{commit}`
  ]);
  try {
    await runGit(repository.path, [
      "cat-file",
      "-e",
      `${headSha}^{commit}`
    ]);
  } catch (cause) {
    if (!isMissingCommitError(cause)) {
      throw cause;
    }

    const error = worktreeError(
      `Expected head commit is missing: ${headSha}`,
      "head_sha_mismatch"
    );
    error.cause = cause;
    throw error;
  }
  await runGit(repository.path, [
    "worktree",
    "add",
    worktreePath,
    fetchedPullHeadRef(pullRequest.pull_number, repository.remote)
  ]);

  const actualHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
  if (actualHead !== headSha) {
    let cleanupCause: unknown;

    try {
      await runGit(repository.path, ["worktree", "remove", worktreePath]);
    } catch (cause) {
      cleanupCause = cause;
    }

    const message =
      cleanupCause === undefined
        ? `Worktree HEAD ${actualHead} did not match expected ${headSha}`
        : `Worktree HEAD ${actualHead} did not match expected ${headSha}; cleanup failed`;
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
