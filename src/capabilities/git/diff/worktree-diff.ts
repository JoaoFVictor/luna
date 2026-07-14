import { runGit as defaultRunGit, runGitBounded } from "../client.js";
import {
  WORKTREE_DIFF_LIMITS,
  type WorktreeDiff,
  type WorktreeDiffFile,
  type WorktreeFileStatus
} from "./worktree-diff-contracts.js";
export {
  WORKTREE_DIFF_LIMITS,
  WorktreeDiffFileSchema,
  WorktreeDiffSchema,
  UntrackedFileSummarySchema
} from "./worktree-diff-contracts.js";
export type {
  UntrackedFileSummary,
  WorktreeDiff,
  WorktreeDiffFile
} from "./worktree-diff-contracts.js";
import {
  nulFields,
  parseNumstat,
  parseRawDiff,
  type NumstatEntry
} from "./parsers.js";
import {
  summarizeUntrackedFiles,
  truncateUtf8ToBytes
} from "./worktree-untracked.js";
import {
  captureApprovedWorktreeSnapshot,
  worktreeSnapshotsEqual,
  type ApprovedWorktreeSnapshot
} from "../worktree-snapshot.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;


function truncateBytes(
  value: string,
  maxBytes: number
): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }

  return {
    value: truncateUtf8ToBytes(value, maxBytes),
    truncated: true
  };
}

function statusFromCodes(indexStatus: string, worktreeStatus: string): WorktreeFileStatus {
  const codes = [indexStatus, worktreeStatus];

  if (indexStatus === "?" && worktreeStatus === "?") {
    return "untracked";
  }

  if (codes.includes("U")) {
    return "unmerged";
  }

  if (codes.includes("R")) {
    return "renamed";
  }

  if (codes.includes("C")) {
    return "copied";
  }

  if (codes.includes("D")) {
    return "deleted";
  }

  if (codes.includes("A")) {
    return "added";
  }

  if (codes.includes("M")) {
    return "modified";
  }

  if (codes.includes("T")) {
    return "changed";
  }

  return "unknown";
}

function parseStatus(status: string): WorktreeDiffFile[] {
  const entries = nulFields(status);
  const files: WorktreeDiffFile[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    const indexStatus = entry[0] ?? " ";
    const worktreeStatus = entry[1] ?? " ";
    const normalizedStatus = statusFromCodes(indexStatus, worktreeStatus);
    const path = entry.slice(3);
    const previousPath =
      normalizedStatus === "renamed" || normalizedStatus === "copied"
        ? entries[++index]
        : undefined;

    if (!path) {
      continue;
    }

    files.push({
      path,
      status: normalizedStatus,
      index_status: indexStatus,
      worktree_status: worktreeStatus,
      ...(previousPath ? { previous_path: previousPath } : {})
    });
  }

  return files;
}

function parseRawSubmodules(raw: string): Set<string> {
  const submodules = new Set<string>();

  for (const entry of parseRawDiff(raw).values()) {
    if (entry.isSubmodule) {
      submodules.add(entry.path);
    }
  }

  return submodules;
}

function applyMetadata(
  file: WorktreeDiffFile,
  numstats: readonly Map<string, NumstatEntry>[],
  submodules: readonly Set<string>[],
  largeThresholdBytes: number
): void {
  const numstat = numstats.find((entries) => entries.has(file.path))?.get(file.path);

  if (numstat?.binary) {
    file.binary = true;
  }

  if (submodules.some((entries) => entries.has(file.path))) {
    file.is_submodule = true;
  }

  if (
    numstat &&
    !numstat.binary &&
    numstat.additions + numstat.deletions > largeThresholdBytes
  ) {
    file.is_large = true;
  }
}

export async function collectWorktreeDiff({
  cwd,
  maxDiffBytes,
  runGit = defaultRunGit,
  captureSnapshot = runGit === defaultRunGit
    ? async (root: string) => await captureApprovedWorktreeSnapshot({ cwd: root })
    : undefined
}: {
  cwd: string;
  maxDiffBytes: number;
  runGit?: RunGit;
  captureSnapshot?: (cwd: string) => Promise<ApprovedWorktreeSnapshot>;
}): Promise<WorktreeDiff> {
  if (!Number.isInteger(maxDiffBytes) || maxDiffBytes <= 0 ||
    maxDiffBytes > WORKTREE_DIFF_LIMITS.max_diff_bytes) {
    throw new Error(
      `maxDiffBytes must be an integer between 1 and ${WORKTREE_DIFF_LIMITS.max_diff_bytes}`
    );
  }

  async function gitOutput(
    args: readonly string[],
    maxBytes: number,
    allowTruncation: boolean
  ): Promise<{ readonly value: string; readonly truncated: boolean }> {
    const normalized = runGit === defaultRunGit
      ? await runGitBounded(cwd, args, maxBytes).then((output) => ({
        value: output.stdout,
        truncated: output.truncated
      }))
      : truncateBytes(await runGit(cwd, args), maxBytes);
    if (normalized.truncated && !allowTruncation) {
      throw new Error(`Git metadata exceeded ${maxBytes} bytes: git ${args.join(" ")}`);
    }
    return normalized;
  }
  const snapshotBefore = await captureSnapshot?.(cwd);
  const parsedStatus = parseStatus(
    (await gitOutput(
      ["status", "--porcelain=v1", "-z"],
      WORKTREE_DIFF_LIMITS.max_git_metadata_bytes,
      false
    )).value
  );
  const status: WorktreeDiffFile[] = [];
  let statusPathBytes = 0;
  for (const file of parsedStatus) {
    const pathBytes = Buffer.byteLength(file.path, "utf8") +
      Buffer.byteLength(file.previous_path ?? "", "utf8");
    if (
      status.length >= WORKTREE_DIFF_LIMITS.max_status_files ||
      statusPathBytes + pathBytes > WORKTREE_DIFF_LIMITS.max_status_path_bytes
    ) {
      continue;
    }
    status.push(file);
    statusPathBytes += pathBytes;
  }
  const staged = await gitOutput(["diff", "--cached", "--binary"], maxDiffBytes, true);
  const unstaged = await gitOutput(["diff", "--binary"], maxDiffBytes, true);
  const stagedNumstat = parseNumstat(
    (await gitOutput(
      ["diff", "--cached", "--numstat", "-z"],
      WORKTREE_DIFF_LIMITS.max_git_metadata_bytes,
      false
    )).value
  );
  const unstagedNumstat = parseNumstat(
    (await gitOutput(
      ["diff", "--numstat", "-z"],
      WORKTREE_DIFF_LIMITS.max_git_metadata_bytes,
      false
    )).value
  );
  const stagedSubmodules = parseRawSubmodules(
    (await gitOutput(
      ["diff", "--cached", "--raw", "-z"],
      WORKTREE_DIFF_LIMITS.max_git_metadata_bytes,
      false
    )).value
  );
  const unstagedSubmodules = parseRawSubmodules(
    (await gitOutput(
      ["diff", "--raw", "-z"],
      WORKTREE_DIFF_LIMITS.max_git_metadata_bytes,
      false
    )).value
  );
  const allUntrackedFiles = status.filter((file) => file.status === "untracked");
  const untrackedFiles = allUntrackedFiles.slice(0, WORKTREE_DIFF_LIMITS.max_untracked_files);
  const perFileSummaryBytes = Math.min(
    maxDiffBytes,
    Math.max(1, Math.floor(
      WORKTREE_DIFF_LIMITS.max_untracked_summary_bytes / Math.max(1, untrackedFiles.length)
    ))
  );
  const untrackedSummaries = await summarizeUntrackedFiles(
    cwd,
    untrackedFiles.map((file) => file.path),
    perFileSummaryBytes,
    WORKTREE_DIFF_LIMITS.untracked_read_concurrency,
  );
  const untrackedByPath = new Map(
    untrackedSummaries.map((summary) => [summary.path, summary])
  );

  for (const file of status) {
    applyMetadata(
      file,
      [stagedNumstat, unstagedNumstat],
      [stagedSubmodules, unstagedSubmodules],
      maxDiffBytes
    );

    if (file.status === "untracked") {
      const summary = untrackedByPath.get(file.path);

      if (summary) {
        file.untracked_summary = summary;

        if (summary.truncated) {
          file.is_large = true;
        }
      }
    }
  }

  const snapshotAfter = await captureSnapshot?.(cwd);
  if (
    snapshotBefore !== undefined &&
    snapshotAfter !== undefined &&
    !worktreeSnapshotsEqual(snapshotBefore, snapshotAfter)
  ) {
    throw new Error("Worktree changed while its review diff was being captured.");
  }

  return {
    files: status,
    untracked_files: untrackedFiles.map((file) => file.path),
    untracked_summaries: untrackedSummaries,
    staged_diff: staged.value,
    unstaged_diff: unstaged.value,
    staged_diff_truncated: staged.truncated,
    unstaged_diff_truncated: unstaged.truncated,
    max_diff_bytes: maxDiffBytes,
    status_files_omitted_count: parsedStatus.length - status.length,
    untracked_files_omitted_count: allUntrackedFiles.length - untrackedFiles.length,
    untracked_summary_bytes: untrackedSummaries.reduce((total, summary) =>
      total + Buffer.byteLength(summary.excerpt.content, "utf8"), 0
    ),
    max_untracked_summary_bytes: WORKTREE_DIFF_LIMITS.max_untracked_summary_bytes,
    ...(snapshotAfter === undefined ? {} : { approved_snapshot: snapshotAfter })
  };
}
