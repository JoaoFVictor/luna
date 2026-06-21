import { mkdir as fsMkdir } from "node:fs/promises";
import path from "node:path";
import { classifyGitFailure } from "./git-failure.js";
import { runGit as defaultRunGit } from "./git.js";
import {
  implementationBranchMetadata,
  type ImplementationBranchError,
  type ImplementationBranchSubject
} from "./implementation-branch.js";
import { safeJoin } from "./path-security.js";
import type { RepositoryConfig, WorkspaceRecord } from "./types.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;
type Mkdir = (
  path: string,
  options: { recursive: boolean; mode: number }
) => Promise<unknown>;

export type ImplementationWorktreeRecord = WorkspaceRecord & {
  repository_id: string;
  remote: string;
  base_ref: string;
  base_sha: string;
  branch: string;
};

type ImplementationWorktreeErrorCode =
  | "branch_mismatch"
  | "branch_collision_retry_exhausted"
  | "invalid_base_ref"
  | "invalid_branch_length"
  | "invalid_branch_pattern";

type ImplementationWorktreeError = Error & {
  code: ImplementationWorktreeErrorCode;
};

type PrepareImplementationWorktreeInput = {
  subject: ImplementationBranchSubject;
  repository: RepositoryConfig;
  workspaceRoot: string;
  runId: string;
  baseRef: string;
  branchPattern?: string;
  maxBranchLength?: number;
  runGit?: RunGit;
  mkdir?: Mkdir;
};

function implementationWorktreeError(
  message: string,
  code: ImplementationWorktreeErrorCode,
  cause?: unknown
): ImplementationWorktreeError {
  const error = new Error(message, { cause }) as ImplementationWorktreeError;
  error.code = code;

  return error;
}

async function validateBaseRef({
  repository,
  baseRef,
  runGit
}: {
  repository: RepositoryConfig;
  baseRef: string;
  runGit: RunGit;
}): Promise<void> {
  try {
    await runGit(repository.path, ["check-ref-format", "--branch", baseRef]);
  } catch (cause) {
    throw implementationWorktreeError(
      `Invalid base ref: ${baseRef}`,
      "invalid_base_ref",
      cause
    );
  }
}

function branchForAttempt({
  subject,
  branchPattern,
  maxBranchLength,
  runId,
  attempt
}: {
  subject: ImplementationBranchSubject;
  branchPattern: string;
  maxBranchLength?: number;
  runId: string;
  attempt: number;
}): string {
  try {
    return implementationBranchMetadata({
      subject,
      branchPattern,
      runId,
      collisionAttempt: attempt,
      maxBranchLength
    }).branchName;
  } catch (error) {
    const branchError = error as Partial<ImplementationBranchError>;

    if (
      branchError.code === "invalid_branch_length" ||
      branchError.code === "invalid_branch_pattern"
    ) {
      throw implementationWorktreeError(
        error instanceof Error ? error.message : "Invalid implementation branch",
        branchError.code,
        error
      );
    }

    throw error;
  }
}

async function validateBranchName({
  repository,
  branch,
  runGit
}: {
  repository: RepositoryConfig;
  branch: string;
  runGit: RunGit;
}): Promise<void> {
  try {
    await runGit(repository.path, ["check-ref-format", "--branch", branch]);
  } catch (cause) {
    throw implementationWorktreeError(
      `Invalid branch name: ${branch}`,
      "invalid_branch_pattern",
      cause
    );
  }
}

async function addWorktreeWithBranchRetry({
  subject,
  repository,
  branchPattern,
  maxBranchLength,
  runId,
  worktreePath,
  baseTarget,
  runGit
}: {
  subject: ImplementationBranchSubject;
  repository: RepositoryConfig;
  branchPattern: string;
  maxBranchLength?: number;
  runId: string;
  worktreePath: string;
  baseTarget: string;
  runGit: RunGit;
}): Promise<string> {
  let lastCollision: unknown;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const branch = branchForAttempt({
      subject,
      branchPattern,
      maxBranchLength,
      runId,
      attempt
    });

    await validateBranchName({ repository, branch, runGit });

    try {
      await runGit(repository.path, [
        "worktree",
        "add",
        "-b",
        branch,
        worktreePath,
        baseTarget
      ]);

      return branch;
    } catch (error) {
      if (classifyGitFailure(error).kind !== "branch_exists") {
        throw error;
      }

      lastCollision = error;
    }
  }

  throw implementationWorktreeError(
    "Branch creation collision retries exhausted",
    "branch_collision_retry_exhausted",
    lastCollision
  );
}

export async function prepareImplementationWorktree({
  subject,
  repository,
  workspaceRoot,
  runId,
  baseRef,
  branchPattern = "feature/{slug}",
  maxBranchLength,
  runGit = defaultRunGit,
  mkdir = fsMkdir
}: PrepareImplementationWorktreeInput): Promise<ImplementationWorktreeRecord> {
  const worktreePath = await safeJoin(workspaceRoot, [repository.id, runId]);

  await validateBaseRef({ repository, baseRef, runGit });
  await mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
  await runGit(repository.path, ["fetch", repository.remote, baseRef]);
  const baseSha = (
    await runGit(repository.path, [
      "rev-parse",
      `${repository.remote}/${baseRef}`
    ])
  ).trim();

  const expectedBranch = await addWorktreeWithBranchRetry({
    subject,
    repository,
    branchPattern,
    maxBranchLength,
    runId,
    worktreePath,
    baseTarget: `${repository.remote}/${baseRef}`,
    runGit
  });

  const actualBranch = (await runGit(worktreePath, [
    "branch",
    "--show-current"
  ])).trim();

  if (actualBranch !== expectedBranch) {
    throw implementationWorktreeError(
      `Worktree branch ${actualBranch} did not match expected ${expectedBranch}`,
      "branch_mismatch"
    );
  }

  return {
    run_id: runId,
    path: worktreePath,
    preserved: true,
    reason: "created",
    repository_id: repository.id,
    remote: repository.remote,
    base_ref: baseRef,
    base_sha: baseSha,
    branch: expectedBranch
  };
}
