import path from "node:path";
import { classifyGitFailure, type GitFailure } from "../git-failure.js";
import { runGit as defaultRunGit } from "../git.js";
import type {
  AppendLocalTransactionJournalEntry,
  LocalTransactionJournalEntry
} from "./transaction-journal.js";
import { appendLocalTransactionJournalEntry } from "./transaction-journal.js";
import { remoteUrlMatches } from "../remote-url.js";
import type { AcceptanceDecision } from "../types.js";
import type { ValidationResult } from "../agent-runtime/contracts.js";
import type {
  CommitChangesArtifact,
  PushBranchArtifact
} from "./types.js";
import type { WorktreeDiff } from "../worktree-diff-collector.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;
type ProcessFailure = {
  code?: unknown;
  exitCode?: unknown;
  killed?: unknown;
  signal?: unknown;
  timedOut?: unknown;
};
function skipped(
  enabled: boolean,
  reason: string
): { enabled: boolean; skipped: true; reason: string } {
  return { enabled, skipped: true, reason };
}

function isAccepted(acceptance: AcceptanceDecision): boolean {
  return acceptance.status === "accepted";
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

function gitFailureSummary(failure: GitFailure): { code: string; message: string } {
  return {
    code: failure.kind,
    message: failure.message
  };
}

function commitStageJournalEntry({
  runId,
  phase,
  timestamp,
  worktreePath,
  repositoryPath,
  indexPath,
  cleanup,
  originalFailure,
  cleanupFailure
}: {
  runId: string;
  phase: LocalTransactionJournalEntry["phase"];
  timestamp: string;
  worktreePath: string;
  repositoryPath?: string;
  indexPath?: string;
  cleanup: LocalTransactionJournalEntry["cleanup"];
  originalFailure?: LocalTransactionJournalEntry["originalFailure"];
  cleanupFailure?: LocalTransactionJournalEntry["cleanupFailure"];
}): LocalTransactionJournalEntry {
  return {
    runId,
    operation: "commit_stage",
    phase,
    timestamp,
    resources: {
      worktreePath,
      ...(repositoryPath === undefined ? {} : { repositoryPath }),
      ...(indexPath === undefined ? {} : { indexPath })
    },
    cleanup,
    indexRestoreStrategy: "reset_to_pre_operation_index",
    ...(originalFailure === undefined ? {} : { originalFailure }),
    ...(cleanupFailure === undefined ? {} : { cleanupFailure })
  };
}

async function appendCommitStageJournal({
  appendJournalEntry,
  runId,
  journalPath,
  phase,
  now,
  worktreePath,
  repositoryPath,
  indexPath,
  cleanup,
  originalFailure,
  cleanupFailure
}: {
  appendJournalEntry?: AppendLocalTransactionJournalEntry;
  runId?: string;
  journalPath?: string;
  phase: LocalTransactionJournalEntry["phase"];
  now: () => Date;
  worktreePath: string;
  repositoryPath?: string;
  indexPath?: string;
  cleanup: LocalTransactionJournalEntry["cleanup"];
  originalFailure?: LocalTransactionJournalEntry["originalFailure"];
  cleanupFailure?: LocalTransactionJournalEntry["cleanupFailure"];
}): Promise<void> {
  if (runId === undefined || runId === "") {
    return;
  }

  const entry = commitStageJournalEntry({
    runId,
    phase,
    timestamp: now().toISOString(),
    worktreePath,
    repositoryPath,
    indexPath,
    cleanup,
    originalFailure,
    cleanupFailure
  });

  if (appendJournalEntry !== undefined) {
    await appendJournalEntry(entry);
    return;
  }

  if (journalPath !== undefined && journalPath !== "") {
    await appendLocalTransactionJournalEntry({ filePath: journalPath, entry });
  }
}

async function appendCommitStageJournalBestEffort(
  input: Parameters<typeof appendCommitStageJournal>[0]
): Promise<unknown> {
  try {
    await appendCommitStageJournal(input);
    return undefined;
  } catch (error) {
    return error;
  }
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
  runId,
  repositoryPath,
  journalPath,
  appendJournalEntry,
  now = () => new Date(),
  runGit = defaultRunGit
}: {
  enabled: boolean;
  cwd: string;
  validation: ValidationResult;
  acceptance: AcceptanceDecision;
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
  appendJournalEntry?: AppendLocalTransactionJournalEntry;
  now?: () => Date;
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

  const indexPath = (await runGit(cwd, ["rev-parse", "--git-path", "index"])).trim();
  const resolvedJournalPath =
    journalPath ??
    (runId === undefined || runId === ""
      ? undefined
      : path.join(cwd, ".luna", `${runId}.transactions.jsonl`));

  try {
    await runGit(cwd, ["diff", "--cached", "--quiet", "--exit-code"]);
  } catch (error) {
    throw classifyGitFailure(error);
  }

  await appendCommitStageJournal({
    appendJournalEntry,
    runId,
    journalPath: resolvedJournalPath,
    phase: "started",
    now,
    worktreePath: cwd,
    repositoryPath,
    indexPath,
    cleanup: {
      attempted: false,
      branchRemovalAllowed: false
    }
  });

  try {
    await runGit(cwd, ["--literal-pathspecs", "add", "-A", "--", ...paths]);
    await runGit(cwd, ["commit", "-m", message]);
  } catch (error) {
    const originalFailure = classifyGitFailure(error);
    const originalFailureSummary = gitFailureSummary(originalFailure);
    await appendCommitStageJournalBestEffort({
      appendJournalEntry,
      runId,
      journalPath: resolvedJournalPath,
      phase: "failed",
      now,
      worktreePath: cwd,
      repositoryPath,
      indexPath,
      cleanup: {
        attempted: false,
        branchRemovalAllowed: false
      },
      originalFailure: originalFailureSummary
    });

    try {
      await runGit(cwd, ["reset", "--mixed", "HEAD"]);
    } catch (cleanupError) {
      await appendCommitStageJournalBestEffort({
        appendJournalEntry,
        runId,
        journalPath: resolvedJournalPath,
        phase: "rolled_back",
        now,
        worktreePath: cwd,
        repositoryPath,
        indexPath,
        cleanup: {
          attempted: true,
          action: "restore_index",
          branchRemovalAllowed: false
        },
        originalFailure: originalFailureSummary,
        cleanupFailure: gitFailureSummary(classifyGitFailure(cleanupError))
      });

      throw originalFailure;
    }

    await appendCommitStageJournalBestEffort({
      appendJournalEntry,
      runId,
      journalPath: resolvedJournalPath,
      phase: "rolled_back",
      now,
      worktreePath: cwd,
      repositoryPath,
      indexPath,
      cleanup: {
        attempted: true,
        action: "restore_index",
        branchRemovalAllowed: false
      },
      originalFailure: originalFailureSummary
    });

    throw originalFailure;
  }

  const commitSha = (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
  await appendCommitStageJournal({
    appendJournalEntry,
    runId,
    journalPath: resolvedJournalPath,
    phase: "succeeded",
    now,
    worktreePath: cwd,
    repositoryPath,
    indexPath,
    cleanup: {
      attempted: false,
      branchRemovalAllowed: false
    }
  });

  return {
    enabled: true,
    skipped: false,
    branch,
    commit_sha: commitSha
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
