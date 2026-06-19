import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runGit as defaultRunGit } from "./git.js";
import { remoteUrlMatches } from "./remote-url.js";
import type {
  CommitChangesArtifact,
  PushBranchArtifact,
  PullRequestArtifact,
  ValidationResult
} from "./types.js";
import type { WorktreeDiff } from "./worktree-diff-collector.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;
type RunGh = (cwd: string, args: readonly string[]) => Promise<string>;
type ProcessFailure = {
  code?: unknown;
  exitCode?: unknown;
  killed?: unknown;
  signal?: unknown;
  timedOut?: unknown;
};
type PullRequestError = Error & {
  code: "pull_request_create_failed";
  cause?: unknown;
};

type AcceptanceLike =
  | { status?: string; decision?: string; accepted?: boolean }
  | boolean;

const execFileAsync = promisify(execFile);

async function defaultRunGh(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", [...args], { cwd });

  return stdout;
}

function skipped(
  enabled: boolean,
  reason: string
): { enabled: boolean; skipped: true; reason: string } {
  return { enabled, skipped: true, reason };
}

function pullRequestError(message: string, cause: unknown): PullRequestError {
  const error = new Error(message, { cause }) as PullRequestError;
  error.code = "pull_request_create_failed";

  return error;
}

function isAccepted(acceptance: AcceptanceLike): boolean {
  if (typeof acceptance === "boolean") {
    return acceptance;
  }

  return (
    acceptance.accepted === true ||
    acceptance.status === "accepted" ||
    acceptance.decision === "approve"
  );
}

function hasDiff(diff: WorktreeDiff): boolean {
  return (
    diff.files.length > 0 ||
    diff.untracked_files.length > 0 ||
    diff.staged_diff.trim() !== "" ||
    diff.unstaged_diff.trim() !== ""
  );
}

function stageablePaths(diff: WorktreeDiff): string[] {
  const paths: string[] = [];

  for (const file of diff.files) {
    if (file.status === "untracked") {
      if (file.untracked_summary?.omitted_reason === "sensitive_path") {
        continue;
      }

      paths.push(file.path);
      continue;
    }

    paths.push(file.path);
  }

  return [...new Set(paths)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function branchMatchesPattern(branch: string, branchPattern: string): boolean {
  const placeholder = "{slug}";
  const placeholderIndex = branchPattern.indexOf(placeholder);

  if (placeholderIndex === -1) {
    return branch === branchPattern;
  }

  const before = branchPattern.slice(0, placeholderIndex);
  const after = branchPattern.slice(placeholderIndex + placeholder.length);
  const pattern = `^${escapeRegExp(before)}[a-z0-9][a-z0-9._-]*${escapeRegExp(after)}$`;

  return new RegExp(pattern).test(branch);
}

function isExpectedAncestryMismatch(error: unknown): boolean {
  const failure =
    (error as { cause?: ProcessFailure } | undefined)?.cause ??
    (error as ProcessFailure | undefined);
  const exitCode = failure?.exitCode ?? failure?.code;

  return (
    exitCode === 1 &&
    failure?.killed !== true &&
    failure?.signal == null &&
    failure?.timedOut !== true
  );
}

async function currentBranch({
  cwd,
  runGit
}: {
  cwd: string;
  runGit: RunGit;
}): Promise<string> {
  return (await runGit(cwd, ["branch", "--show-current"])).trim();
}

async function remoteMatches({
  cwd,
  remote,
  expectedRemoteUrls,
  runGit
}: {
  cwd: string;
  remote: string;
  expectedRemoteUrls: readonly string[];
  runGit: RunGit;
}): Promise<boolean> {
  const actualRemoteUrl = (await runGit(cwd, ["remote", "get-url", remote])).trim();

  return remoteUrlMatches(actualRemoteUrl, expectedRemoteUrls);
}

export async function commitChanges({
  enabled,
  cwd,
  validation,
  acceptance,
  diff,
  branch,
  remote,
  baseSha,
  branchPattern,
  expectedRemoteUrls,
  message,
  runGit = defaultRunGit
}: {
  enabled: boolean;
  cwd: string;
  validation: ValidationResult;
  acceptance: AcceptanceLike;
  diff: WorktreeDiff;
  branch: string;
  remote: string;
  baseSha: string;
  branchPattern: string;
  expectedRemoteUrls: readonly string[];
  message: string;
  runGit?: RunGit;
}): Promise<CommitChangesArtifact> {
  if (!enabled) {
    return skipped(false, "disabled");
  }

  if (!validation.passed) {
    return skipped(true, "validation_failed");
  }

  if (!isAccepted(acceptance)) {
    return skipped(true, "acceptance_rejected");
  }

  if (!hasDiff(diff)) {
    return skipped(true, "empty_diff");
  }

  const branchNow = await currentBranch({ cwd, runGit });

  if (branchNow !== branch) {
    return skipped(true, "branch_mismatch");
  }

  if (!branchMatchesPattern(branchNow, branchPattern)) {
    return skipped(true, "branch_pattern_mismatch");
  }

  if (!(await remoteMatches({ cwd, remote, expectedRemoteUrls, runGit }))) {
    return skipped(true, "remote_url_mismatch");
  }

  try {
    await runGit(cwd, ["merge-base", "--is-ancestor", baseSha, "HEAD"]);
  } catch (error) {
    if (isExpectedAncestryMismatch(error)) {
      return skipped(true, "base_ancestry_mismatch");
    }

    throw error;
  }

  const paths = stageablePaths(diff);

  if (paths.length === 0) {
    return skipped(true, "sensitive_untracked_files");
  }

  await runGit(cwd, ["add", "-A", "--", ...paths]);
  await runGit(cwd, ["commit", "-m", message]);

  return {
    enabled: true,
    skipped: false,
    branch,
    commit_sha: (await runGit(cwd, ["rev-parse", "HEAD"])).trim()
  };
}

export async function pushBranch({
  enabled,
  cwd,
  commit,
  branch,
  remote,
  expectedRemoteUrls,
  runGit = defaultRunGit
}: {
  enabled: boolean;
  cwd: string;
  commit: CommitChangesArtifact;
  branch: string;
  remote: string;
  expectedRemoteUrls: readonly string[];
  runGit?: RunGit;
}): Promise<PushBranchArtifact> {
  if (!enabled) {
    return skipped(false, "disabled");
  }

  if (commit.skipped || commit.commit_sha === undefined) {
    return skipped(true, "no_commit");
  }

  if (commit.branch !== branch) {
    return skipped(true, "branch_mismatch");
  }

  if ((await currentBranch({ cwd, runGit })) !== branch) {
    return skipped(true, "branch_mismatch");
  }

  if (!(await remoteMatches({ cwd, remote, expectedRemoteUrls, runGit }))) {
    return skipped(true, "remote_url_mismatch");
  }

  await runGit(cwd, ["push", remote, `HEAD:refs/heads/${branch}`]);

  return {
    enabled: true,
    skipped: false,
    remote,
    branch
  };
}

export async function openPullRequest({
  enabled,
  cwd,
  push,
  branch,
  provider,
  baseRef,
  draft,
  title,
  body,
  runGh = defaultRunGh
}: {
  enabled: boolean;
  cwd: string;
  push: PushBranchArtifact;
  branch: string;
  provider: string;
  baseRef?: string;
  draft: boolean;
  title: string;
  body?: string;
  runGh?: RunGh;
}): Promise<PullRequestArtifact> {
  if (!enabled) {
    return skipped(false, "disabled");
  }

  if (push.skipped) {
    return skipped(true, "no_push");
  }

  if (push.branch !== branch) {
    return skipped(true, "branch_mismatch");
  }

  if (provider !== "github") {
    return skipped(true, "provider_unsupported");
  }

  if (baseRef === undefined || baseRef.trim() === "") {
    return skipped(true, "base_ref_missing");
  }

  try {
    await runGh(cwd, ["auth", "status"]);
  } catch {
    return skipped(true, "gh_not_authenticated");
  }

  const args = ["pr", "create"];

  if (draft) {
    args.push("--draft");
  }

  args.push("--base", baseRef, "--head", branch, "--title", title);

  if (body !== undefined) {
    args.push("--body", body);
  }

  let url: string;
  try {
    url = (await runGh(cwd, args)).trim();
  } catch (cause) {
    throw pullRequestError("Failed to create GitHub pull request", cause);
  }

  return {
    enabled: true,
    skipped: false,
    provider: "github",
    ...(url === "" ? {} : { url })
  };
}
