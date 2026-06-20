import { mkdir as fsMkdir } from "node:fs/promises";
import path from "node:path";
import { runGit as defaultRunGit } from "./git.js";
import { jiraIssueContextFrom } from "./jira-issue-context.js";
import { safeJoin } from "./path-security.js";
import type {
  Invocation,
  RepositoryConfig,
  WorkspaceRecord
} from "./types.js";

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

function implementationWorktreeError(
  message: string,
  code: ImplementationWorktreeErrorCode,
  cause?: unknown
): ImplementationWorktreeError {
  const error = new Error(message, { cause }) as ImplementationWorktreeError;
  error.code = code;

  return error;
}

function normalizeSlugPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truncateAtHyphenBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength).replace(/-+$/g, "");
}

function runBranchSuffix(runId: string): string {
  return runId.split("-").slice(-2).join("-").slice(0, 24);
}

function buildSlug({
  issueKey,
  summary,
  maxLength
}: {
  issueKey: string;
  summary: string;
  maxLength?: number;
}): string {
  const issueSlug = normalizeSlugPart(issueKey) || "issue";
  const summarySlug = normalizeSlugPart(summary);

  if (summarySlug === "") {
    return issueSlug;
  }

  if (maxLength === undefined) {
    return `${issueSlug}-${summarySlug}`;
  }

  const separatorLength = 1;
  const summaryBudget = maxLength - issueSlug.length - separatorLength;

  if (summaryBudget <= 0) {
    return issueSlug;
  }

  const truncatedSummary = truncateAtHyphenBoundary(summarySlug, summaryBudget);

  return truncatedSummary === ""
    ? issueSlug
    : `${issueSlug}-${truncatedSummary}`;
}

function branchName({
  issueKey,
  summary,
  branchPattern,
  suffix,
  maxBranchLength
}: {
  issueKey: string;
  summary: string;
  branchPattern: string;
  suffix: string;
  maxBranchLength?: number;
}): string {
  const placeholder = "{slug}";
  const placeholderIndex = branchPattern.indexOf(placeholder);

  if (placeholderIndex === -1) {
    throw implementationWorktreeError(
      `Branch pattern must include ${placeholder}`,
      "invalid_branch_pattern"
    );
  }

  const staticLength = branchPattern.length - placeholder.length;
  const maxSlugLength =
    maxBranchLength === undefined
      ? undefined
      : Math.max(0, maxBranchLength - staticLength - suffix.length);
  const issueSlug = normalizeSlugPart(issueKey) || "issue";

  if (maxSlugLength !== undefined && maxBranchLength !== undefined) {
    if (
      maxSlugLength < issueSlug.length ||
      staticLength + suffix.length + issueSlug.length > maxBranchLength
    ) {
      throw implementationWorktreeError(
        "Branch pattern and suffix exceed max branch length",
        "invalid_branch_length"
      );
    }
  }

  const slug = buildSlug({
    issueKey,
    summary,
    maxLength: maxSlugLength
  });

  return branchPattern.replace(placeholder, `${slug}${suffix}`);
}

function branchSuffix(runId: string, attempt: number): string {
  const runSuffix = runBranchSuffix(runId);
  const retrySuffix = attempt === 1 ? "" : `-${attempt}`;

  return runSuffix === "" ? retrySuffix : `-${runSuffix}${retrySuffix}`;
}

function isBranchAlreadyExistsError(error: unknown): boolean {
  const errorLike = error as
    | {
        code?: unknown;
        stderr?: unknown;
        message?: unknown;
      }
    | undefined;
  const causeLike = (error as { cause?: { stderr?: unknown; message?: unknown } })
    ?.cause;
  const haystack = [
    errorLike?.stderr,
    errorLike?.message,
    causeLike?.stderr,
    causeLike?.message
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();

  return errorLike?.code === "branch_exists" || haystack.includes("already exists");
}

async function branchExists({
  repository,
  branch,
  runGit
}: {
  repository: RepositoryConfig;
  branch: string;
  runGit: RunGit;
}): Promise<boolean> {
  const refs = await runGit(repository.path, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/heads/${branch}`,
    `refs/remotes/${repository.remote}/${branch}`
  ]);

  if (refs.trim() !== "") {
    return true;
  }

  const remoteRefs = await runGit(repository.path, [
    "ls-remote",
    "--heads",
    repository.remote,
    branch
  ]);

  return remoteRefs.trim() !== "";
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

async function availableBranch({
  task,
  repository,
  branchPattern,
  runId,
  maxBranchLength,
  runGit
}: {
  task: {
    issueKey: string;
    title?: string;
  };
  repository: RepositoryConfig;
  branchPattern: string;
  runId: string;
  maxBranchLength?: number;
  runGit: RunGit;
}): Promise<{ branch: string; attempt: number }> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const branch = branchName({
      issueKey: task.issueKey,
      summary: task.title ?? task.issueKey,
      branchPattern,
      suffix: branchSuffix(runId, attempt),
      maxBranchLength
    });

    if (!(await branchExists({ repository, branch, runGit }))) {
      return { branch, attempt };
    }
  }

  throw implementationWorktreeError(
    "Branch availability collision retries exhausted",
    "branch_collision_retry_exhausted"
  );
}

async function addWorktreeWithBranchRetry({
  task,
  repository,
  branchPattern,
  maxBranchLength,
  runId,
  worktreePath,
  baseTarget,
  initialBranch,
  initialAttempt,
  runGit
}: {
  task: {
    issueKey: string;
    title?: string;
  };
  repository: RepositoryConfig;
  branchPattern: string;
  maxBranchLength?: number;
  runId: string;
  worktreePath: string;
  baseTarget: string;
  initialBranch: string;
  initialAttempt: number;
  runGit: RunGit;
}): Promise<string> {
  let lastCollision: unknown;

  for (let attempt = initialAttempt; attempt <= 5; attempt += 1) {
    const branch =
      attempt === initialAttempt
        ? initialBranch
        : branchName({
            issueKey: task.issueKey,
            summary: task.title ?? task.issueKey,
            branchPattern,
            suffix: branchSuffix(runId, attempt),
            maxBranchLength
          });

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
      if (!isBranchAlreadyExistsError(error)) {
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
  invocation,
  repository,
  workspaceRoot,
  runId,
  baseRef,
  branchPattern = "feature/{slug}",
  maxBranchLength,
  runGit = defaultRunGit,
  mkdir = fsMkdir
}: {
  invocation: Invocation;
  repository: RepositoryConfig;
  workspaceRoot: string;
  runId: string;
  baseRef: string;
  branchPattern?: string;
  maxBranchLength?: number;
  runGit?: RunGit;
  mkdir?: Mkdir;
}): Promise<ImplementationWorktreeRecord> {
  const task = jiraIssueContextFrom(invocation);
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
  const { branch, attempt } = await availableBranch({
    task,
    repository,
    branchPattern,
    runId,
    maxBranchLength,
    runGit
  });

  const actualExpectedBranch = await addWorktreeWithBranchRetry({
    task,
    repository,
    branchPattern,
    maxBranchLength,
    runId,
    worktreePath,
    baseTarget: `${repository.remote}/${baseRef}`,
    initialBranch: branch,
    initialAttempt: attempt,
    runGit
  });

  const actualBranch = (await runGit(worktreePath, [
    "branch",
    "--show-current"
  ])).trim();

  if (actualBranch !== actualExpectedBranch) {
    throw implementationWorktreeError(
      `Worktree branch ${actualBranch} did not match expected ${actualExpectedBranch}`,
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
    branch: actualExpectedBranch
  };
}
