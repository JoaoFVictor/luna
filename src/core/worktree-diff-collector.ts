import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit as defaultRunGit } from "./git.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;

type WorktreeFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "changed"
  | "unmerged"
  | "unknown";

type FileExcerpt = {
  start_line: number;
  end_line: number;
  content: string;
  truncated?: boolean;
};

export type UntrackedFileSummary = {
  path: string;
  excerpt: FileExcerpt;
  truncated: boolean;
  bytes: number;
  max_bytes: number;
};

export type WorktreeDiffFile = {
  path: string;
  status: WorktreeFileStatus;
  index_status: string;
  worktree_status: string;
  previous_path?: string;
  binary?: boolean;
  is_submodule?: boolean;
  is_large?: boolean;
  untracked_summary?: UntrackedFileSummary;
};

export type WorktreeDiff = {
  files: WorktreeDiffFile[];
  untracked_files: string[];
  untracked_summaries: UntrackedFileSummary[];
  staged_diff: string;
  unstaged_diff: string;
  staged_diff_truncated: boolean;
  unstaged_diff_truncated: boolean;
  max_diff_bytes: number;
};

function truncateBytes(
  value: string,
  maxBytes: number
): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }

  return {
    value: Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true
  };
}

function nulFields(output: string): string[] {
  const fields = output.split("\0");

  if (fields.at(-1) === "") {
    fields.pop();
  }

  return fields;
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

type NumstatEntry = {
  binary: boolean;
  additions: number;
  deletions: number;
};

function parseCount(value: string): number {
  return value === "-" ? 0 : Number.parseInt(value, 10);
}

function parseNumstat(numstat: string): Map<string, NumstatEntry> {
  const entries = new Map<string, NumstatEntry>();
  const fields = nulFields(numstat);

  for (let index = 0; index < fields.length; ) {
    const stats = fields[index++];
    const firstTab = stats.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : stats.indexOf("\t", firstTab + 1);

    if (firstTab === -1 || secondTab === -1) {
      continue;
    }

    const additions = stats.slice(0, firstTab);
    const deletions = stats.slice(firstTab + 1, secondTab);
    const pathInStats = stats.slice(secondTab + 1);
    const path = pathInStats === "" ? fields[index + 1] : pathInStats;

    if (pathInStats === "") {
      index += 2;
    }

    if (!additions || !deletions || !path) {
      continue;
    }

    entries.set(path, {
      binary: additions === "-" && deletions === "-",
      additions: parseCount(additions),
      deletions: parseCount(deletions)
    });
  }

  return entries;
}

function parseRawSubmodules(raw: string): Set<string> {
  const submodules = new Set<string>();
  const fields = nulFields(raw);

  for (let index = 0; index < fields.length; ) {
    const metadata = fields[index++];
    const [, oldMode, newMode, , , statusCode] =
      metadata.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (\S+)$/) ?? [];

    if (!oldMode || !newMode || !statusCode) {
      continue;
    }

    const isRenameOrCopy = statusCode.startsWith("R") || statusCode.startsWith("C");
    const firstPath = fields[index++];
    const secondPath = isRenameOrCopy ? fields[index++] : undefined;
    const path = isRenameOrCopy ? secondPath : firstPath;

    if (path && (oldMode === "160000" || newMode === "160000")) {
      submodules.add(path);
    }
  }

  return submodules;
}

function truncateUtf8ToBytes(content: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  let bytesUsed = 0;
  let truncated = "";

  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, "utf8");

    if (bytesUsed + characterBytes > maxBytes) {
      break;
    }

    truncated += character;
    bytesUsed += characterBytes;
  }

  return truncated;
}

function lineCount(content: string): number {
  if (content.length === 0) {
    return 1;
  }

  const lines = content.split("\n").length;
  return content.endsWith("\n") ? Math.max(1, lines - 1) : lines;
}

function excerptForContent(content: string, maxBytes: number): FileExcerpt {
  const truncated = Buffer.byteLength(content, "utf8") > maxBytes;
  const excerptContent = truncated ? truncateUtf8ToBytes(content, maxBytes) : content;

  return {
    start_line: 1,
    end_line: lineCount(excerptContent),
    content: excerptContent,
    ...(truncated ? { truncated: true } : {})
  };
}

async function summarizeUntrackedFile(
  cwd: string,
  path: string,
  maxBytes: number
): Promise<UntrackedFileSummary> {
  let content = "";

  try {
    content = await readFile(join(cwd, path), "utf8");
  } catch {
    content = "";
  }

  const bytes = Buffer.byteLength(content, "utf8");
  const excerpt = excerptForContent(content, maxBytes);

  return {
    path,
    excerpt,
    truncated: excerpt.truncated === true,
    bytes,
    max_bytes: maxBytes
  };
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
  runGit = defaultRunGit
}: {
  cwd: string;
  maxDiffBytes: number;
  runGit?: RunGit;
}): Promise<WorktreeDiff> {
  const status = parseStatus(
    await runGit(cwd, ["status", "--porcelain=v1", "-z"])
  );
  const staged = truncateBytes(
    await runGit(cwd, ["diff", "--cached", "--binary"]),
    maxDiffBytes
  );
  const unstaged = truncateBytes(
    await runGit(cwd, ["diff", "--binary"]),
    maxDiffBytes
  );
  const stagedNumstat = parseNumstat(
    await runGit(cwd, ["diff", "--cached", "--numstat", "-z"])
  );
  const unstagedNumstat = parseNumstat(
    await runGit(cwd, ["diff", "--numstat", "-z"])
  );
  const stagedSubmodules = parseRawSubmodules(
    await runGit(cwd, ["diff", "--cached", "--raw", "-z"])
  );
  const unstagedSubmodules = parseRawSubmodules(
    await runGit(cwd, ["diff", "--raw", "-z"])
  );
  const untrackedFiles = status.filter((file) => file.status === "untracked");
  const untrackedSummaries = await Promise.all(
    untrackedFiles.map((file) => summarizeUntrackedFile(cwd, file.path, maxDiffBytes))
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

  return {
    files: status,
    untracked_files: untrackedFiles.map((file) => file.path),
    untracked_summaries: untrackedSummaries,
    staged_diff: staged.value,
    unstaged_diff: unstaged.value,
    staged_diff_truncated: staged.truncated,
    unstaged_diff_truncated: unstaged.truncated,
    max_diff_bytes: maxDiffBytes
  };
}
