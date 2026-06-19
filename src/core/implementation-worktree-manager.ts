import { mkdir as fsMkdir } from "node:fs/promises";
import path from "node:path";
import { runGit as defaultRunGit } from "./git.js";
import { safeJoin } from "./path-security.js";
import type {
  JiraTaskInvocation,
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
  | "invalid_base_ref"
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
  const slug = buildSlug({
    issueKey,
    summary,
    maxLength: maxSlugLength
  });

  return branchPattern.replace(placeholder, `${slug}${suffix}`);
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
  invocation,
  repository,
  branchPattern,
  maxBranchLength,
  runGit
}: {
  invocation: JiraTaskInvocation;
  repository: RepositoryConfig;
  branchPattern: string;
  maxBranchLength?: number;
  runGit: RunGit;
}): Promise<string> {
  let attempt = 1;

  while (true) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const branch = branchName({
      issueKey: invocation.jira.issue_key,
      summary: invocation.jira.summary,
      branchPattern,
      suffix,
      maxBranchLength
    });

    if (!(await branchExists({ repository, branch, runGit }))) {
      return branch;
    }

    attempt += 1;
  }
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
  invocation: JiraTaskInvocation;
  repository: RepositoryConfig;
  workspaceRoot: string;
  runId: string;
  baseRef: string;
  branchPattern?: string;
  maxBranchLength?: number;
  runGit?: RunGit;
  mkdir?: Mkdir;
}): Promise<ImplementationWorktreeRecord> {
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
  const branch = await availableBranch({
    invocation,
    repository,
    branchPattern,
    maxBranchLength,
    runGit
  });

  await runGit(repository.path, [
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    `${repository.remote}/${baseRef}`
  ]);

  const actualBranch = (await runGit(worktreePath, [
    "branch",
    "--show-current"
  ])).trim();

  if (actualBranch !== branch) {
    throw implementationWorktreeError(
      `Worktree branch ${actualBranch} did not match expected ${branch}`,
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
    branch
  };
}
