import { runGit as defaultRunGit } from "./git.js";
import type {
  ChangedFile,
  FileExcerpt,
  Invocation,
  RepoContext,
  RepositoryConfig
} from "./types.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;

type CollectRepoContextOptions = {
  invocation: Invocation;
  repository: RepositoryConfig;
  runGit?: RunGit;
  maxChangedFiles?: number;
  maxDiffBytes?: number;
  maxExcerptBytes?: number;
};

type FileStatus = ChangedFile["status"];

type RawEntry = {
  path: string;
  previousPath?: string;
  status: FileStatus;
  oldMode: string;
  newMode: string;
  isSubmodule: boolean;
};

type NumstatEntry = {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

type NameStatusEntry = {
  path: string;
  previousPath?: string;
  status: FileStatus;
};

const DEFAULT_MAX_CHANGED_FILES = 100;
const DEFAULT_MAX_DIFF_BYTES = 200_000;
const DEFAULT_MAX_EXCERPT_BYTES = 8_000;
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

function statusFromCode(code: string): FileStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "changed";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
}

function parseRaw(raw: string): Map<string, RawEntry> {
  const entries = new Map<string, RawEntry>();

  for (const line of raw.split("\n").filter((value) => value.length > 0)) {
    const [metadata, ...paths] = line.split("\t");
    const [, oldMode, newMode, , , statusCode] =
      metadata.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (\S+)$/) ?? [];

    if (!oldMode || !newMode || !statusCode || paths.length === 0) {
      continue;
    }

    const status = statusFromCode(statusCode);
    const path = status === "renamed" || status === "copied" ? paths[1] : paths[0];
    const previousPath = status === "renamed" ? paths[0] : undefined;

    if (!path) {
      continue;
    }

    entries.set(path, {
      path,
      previousPath,
      status,
      oldMode,
      newMode,
      isSubmodule: oldMode === "160000" || newMode === "160000"
    });
  }

  return entries;
}

function parseCount(value: string): number {
  return value === "-" ? 0 : Number.parseInt(value, 10);
}

function parseNumstat(numstat: string): Map<string, NumstatEntry> {
  const entries = new Map<string, NumstatEntry>();

  for (const line of numstat.split("\n").filter((value) => value.length > 0)) {
    const [additions, deletions, firstPath, secondPath] = line.split("\t");
    const path = secondPath ?? firstPath;

    if (!additions || !deletions || !path) {
      continue;
    }

    entries.set(path, {
      path,
      additions: parseCount(additions),
      deletions: parseCount(deletions),
      binary: additions === "-" && deletions === "-"
    });
  }

  return entries;
}

function parseNameStatus(nameStatus: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];

  for (const line of nameStatus.split("\n").filter((value) => value.length > 0)) {
    const [statusCode, firstPath, secondPath] = line.split("\t");
    const status = statusFromCode(statusCode);
    const path = status === "renamed" || status === "copied" ? secondPath : firstPath;
    const previousPath = status === "renamed" ? firstPath : undefined;

    if (!path) {
      continue;
    }

    entries.push({ path, previousPath, status });
  }

  return entries;
}

function lineCount(content: string): number {
  if (content.length === 0) {
    return 1;
  }

  return content.split("\n").length;
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

function excerptForContent(content: string, maxBytes: number): FileExcerpt {
  const truncated = Buffer.byteLength(content, "utf8") > maxBytes;
  const excerptContent = truncated ? truncateUtf8ToBytes(content, maxBytes) : content;

  return {
    start_line: 1,
    end_line: Math.max(1, lineCount(excerptContent)),
    content: excerptContent,
    ...(truncated ? { truncated: true } : {})
  };
}

function patchWithinBudget(patch: string, remainingBytes: number): string | null {
  if (remainingBytes <= 0) {
    return null;
  }

  if (Buffer.byteLength(patch, "utf8") <= remainingBytes) {
    return patch;
  }

  return truncateUtf8ToBytes(patch, remainingBytes);
}

export async function collectRepoContext({
  invocation,
  repository,
  runGit = defaultRunGit,
  maxChangedFiles = DEFAULT_MAX_CHANGED_FILES,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
  maxExcerptBytes = DEFAULT_MAX_EXCERPT_BYTES
}: CollectRepoContextOptions): Promise<RepoContext> {
  const baseSha = invocation.references.base_sha;
  const headSha = invocation.references.head_sha;
  const cwd = repository.path;

  const mergeBase = (await runGit(cwd, ["merge-base", baseSha, headSha])).trim();
  const statusShort = (await runGit(cwd, ["status", "--short"]))
    .split("\n")
    .filter((line) => line.length > 0);
  const rawEntries = parseRaw(await runGit(cwd, ["diff", "--raw", baseSha, headSha]));
  const numstatEntries = parseNumstat(
    await runGit(cwd, ["diff", "--numstat", baseSha, headSha])
  );
  const nameStatusEntries = parseNameStatus(
    await runGit(cwd, ["diff", "--name-status", baseSha, headSha])
  );

  const totalChangedFiles = nameStatusEntries.length;
  const selectedEntries = nameStatusEntries.slice(0, maxChangedFiles);
  const fileExcerptsTruncated: string[] = [];
  let remainingDiffBytes = maxDiffBytes;

  const files: ChangedFile[] = [];

  for (const entry of selectedEntries) {
    const raw = rawEntries.get(entry.path);
    const numstat = numstatEntries.get(entry.path);
    const isSubmodule = raw?.isSubmodule ?? false;
    const binary = numstat?.binary ?? false;
    const status = raw?.status ?? entry.status;
    const previousPath = raw?.previousPath ?? entry.previousPath;
    const additions = numstat?.additions ?? 0;
    const deletions = numstat?.deletions ?? 0;
    const file: ChangedFile = {
      path: entry.path,
      status,
      additions,
      deletions,
      ...(binary ? { binary: true } : {}),
      ...(previousPath ? { previous_path: previousPath } : {}),
      ...(isSubmodule ? { is_submodule: true } : {}),
      patch: null,
      excerpt: null
    };

    const canReadHead = !binary && status !== "deleted" && !isSubmodule;

    if (!binary && status !== "deleted" && !isSubmodule) {
      const fullPatch = await runGit(cwd, ["diff", baseSha, headSha, "--", entry.path]);
      const patch = patchWithinBudget(fullPatch, remainingDiffBytes);
      file.patch = patch;
      remainingDiffBytes = Math.max(
        0,
        remainingDiffBytes - Buffer.byteLength(patch ?? "", "utf8")
      );
    }

    if (canReadHead) {
      const content = await runGit(cwd, ["show", `${headSha}:${entry.path}`]);
      const excerpt = excerptForContent(content, maxExcerptBytes);

      if (excerpt.truncated) {
        file.is_large = true;
        fileExcerptsTruncated.push(entry.path);
      }

      if (content.startsWith(LFS_POINTER_PREFIX)) {
        file.is_lfs_pointer = true;
      }

      file.excerpt = excerpt;
    }

    files.push(file);
  }

  return {
    repository: {
      owner: repository.owner,
      name: repository.name,
      full_name: `${repository.owner}/${repository.name}`
    },
    base_sha: baseSha,
    head_sha: headSha,
    merge_base: mergeBase,
    files,
    changed_files_truncated: totalChangedFiles > selectedEntries.length,
    total_changed_files: totalChangedFiles,
    changed_file_limit: maxChangedFiles,
    file_excerpts_truncated: fileExcerptsTruncated,
    git: {
      merge_base: mergeBase,
      status_short: statusShort
    }
  };
}
