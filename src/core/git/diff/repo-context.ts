import { runGit as defaultRunGit } from "../client.js";
import {
  gitFileStatusFromCode,
  nulFields,
  parseNumstat,
  parseRawDiff
} from "./parsers.js";
import type {
  ChangedFile,
  FileExcerpt,
  RepoContext
} from "./types.js";
import type { RepositoryConfig } from "../../config/schemas.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;
type FileStatus = ChangedFile["status"];

type CollectRepoContextOptions = {
  repository: RepositoryConfig;
  baseSha: string;
  headSha: string;
  runGit?: RunGit;
  maxChangedFiles?: number;
  maxDiffBytes?: number;
  maxExcerptBytes?: number;
};

type PatchBudgetResult = {
  patch: string | null;
  truncated: boolean;
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

function parseNameStatus(nameStatus: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  const fields = nulFields(nameStatus);

  for (let index = 0; index < fields.length; ) {
    const statusCode = fields[index++];
    const status = gitFileStatusFromCode(statusCode);
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
  const rawEntries = parseRawDiff(await runGit(cwd, ["diff", "--raw", "-z", baseSha, headSha]));
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
