import { runGit as defaultRunGit } from "./git.js";
import type {
  ChangedFile,
  FileExcerpt,
  RepoContext,
  RepositoryConfig
} from "./types.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;

type CollectRepoContextOptions = {
  repository: RepositoryConfig;
  baseSha: string;
  headSha: string;
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

type PatchBudgetResult = {
  patch: string | null;
  truncated: boolean;
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

function nulFields(output: string): string[] {
  const fields = output.split("\0");

  if (fields.at(-1) === "") {
    fields.pop();
  }

  return fields;
}

function parseRaw(raw: string): Map<string, RawEntry> {
  const entries = new Map<string, RawEntry>();
  const fields = nulFields(raw);

  for (let index = 0; index < fields.length; ) {
    const metadata = fields[index++];
    const [, oldMode, newMode, , , statusCode] =
      metadata.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (\S+)$/) ?? [];

    if (!oldMode || !newMode || !statusCode) {
      continue;
    }

    const status = statusFromCode(statusCode);
    const firstPath = fields[index++];
    const secondPath = status === "renamed" || status === "copied" ? fields[index++] : undefined;
    const path = status === "renamed" || status === "copied" ? secondPath : firstPath;
    const previousPath = status === "renamed" ? firstPath : undefined;

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
  const fields = nulFields(nameStatus);

  for (let index = 0; index < fields.length; ) {
    const statusCode = fields[index++];
    const status = statusFromCode(statusCode);
    const firstPath = fields[index++];
    const secondPath = status === "renamed" || status === "copied" ? fields[index++] : undefined;
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

function patchWithinBudget(patch: string, remainingBytes: number): PatchBudgetResult {
  if (remainingBytes <= 0) {
    return { patch: null, truncated: false };
  }

  if (Buffer.byteLength(patch, "utf8") <= remainingBytes) {
    return { patch, truncated: false };
  }

  return { patch: truncateUtf8ToBytes(patch, remainingBytes), truncated: true };
}

export async function collectRepoContext({
  repository,
  baseSha,
  headSha,
  runGit = defaultRunGit,
  maxChangedFiles = DEFAULT_MAX_CHANGED_FILES,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
  maxExcerptBytes = DEFAULT_MAX_EXCERPT_BYTES
}: CollectRepoContextOptions): Promise<RepoContext> {
  const cwd = repository.path;

  const mergeBase = (await runGit(cwd, ["merge-base", baseSha, headSha])).trim();
  const statusShort = (await runGit(cwd, ["status", "--short"]))
    .split("\n")
    .filter((line) => line.length > 0);
  const rawEntries = parseRaw(await runGit(cwd, ["diff", "--raw", "-z", baseSha, headSha]));
  const numstatEntries = parseNumstat(
    await runGit(cwd, ["diff", "--numstat", "-z", baseSha, headSha])
  );
  const nameStatusEntries = parseNameStatus(
    await runGit(cwd, ["diff", "--name-status", "-z", baseSha, headSha])
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

    if (binary) {
      file.patch_omitted_reason = "binary";
    } else if (status === "deleted") {
      file.patch_omitted_reason = "deleted";
    } else if (isSubmodule) {
      file.patch_omitted_reason = "submodule";
    } else if (remainingDiffBytes <= 0) {
      file.patch_omitted_reason = "diff_budget_exhausted";
    } else {
      const fullPatch = await runGit(cwd, ["diff", baseSha, headSha, "--", entry.path]);
      const { patch, truncated } = patchWithinBudget(fullPatch, remainingDiffBytes);

      file.patch = patch;

      if (truncated) {
        file.patch_truncated = true;
      }

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
