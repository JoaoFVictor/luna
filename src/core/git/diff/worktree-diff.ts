import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { runGit as defaultRunGit } from "../client.js";
import { redactString } from "../../security/redactor.js";
import {
  nulFields,
  parseNumstat,
  parseRawDiff,
  type NumstatEntry
} from "./parsers.js";

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
  symlink?: boolean;
  omitted?: boolean;
  omitted_reason?: "symlink" | "sensitive_path";
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
  const excerptContent = redactString(
    truncated ? truncateUtf8ToBytes(content, maxBytes) : content
  );

  return {
    start_line: 1,
    end_line: lineCount(excerptContent),
    content: excerptContent,
    ...(truncated ? { truncated: true } : {})
  };
}

function isSensitiveUntrackedPath(path: string): boolean {
  const segments = path.split(/[\\/]/);
  const basename = segments.at(-1)?.toLowerCase() ?? "";

  return (
    basename === ".npmrc" ||
    basename === ".yarnrc" ||
    basename === ".pypirc" ||
    basename === ".netrc" ||
    basename === "credentials" ||
    basename === "credentials.json" ||
    basename === "luna.auth.json" ||
    basename.startsWith(".env")
  );
}

async function readFilePrefix(
  path: string,
  maxBytes: number
): Promise<string> {
  if (maxBytes <= 0) {
    return "";
  }

  const handle = await open(path, "r");

  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function summarizeUntrackedFile(
  cwd: string,
  path: string,
  maxBytes: number
): Promise<UntrackedFileSummary> {
  let content = "";
  let bytes = 0;
  const emptyExcerpt = excerptForContent("", maxBytes);
  const fullPath = join(cwd, path);

  try {
    const stats = await lstat(fullPath);

    if (stats.isSymbolicLink()) {
      return {
        path,
        excerpt: emptyExcerpt,
        truncated: false,
        bytes: 0,
        max_bytes: maxBytes,
        symlink: true,
        omitted: true,
        omitted_reason: "symlink"
      };
    }

    bytes = stats.size;

    if (isSensitiveUntrackedPath(path)) {
      return {
        path,
        excerpt: emptyExcerpt,
        truncated: false,
        bytes,
        max_bytes: maxBytes,
        omitted: true,
        omitted_reason: "sensitive_path"
      };
    }

    content = await readFilePrefix(fullPath, maxBytes);
  } catch {
    content = "";
  }

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
