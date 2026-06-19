import { runGit as defaultRunGit } from "./git.js";

type RunGit = (cwd: string, args: readonly string[]) => Promise<string>;

export type WorktreeDiffFile = {
  path: string;
  index_status: string;
  worktree_status: string;
};

export type WorktreeDiff = {
  files: WorktreeDiffFile[];
  untracked_files: string[];
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

function parseStatus(status: string): WorktreeDiffFile[] {
  return status
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => ({
      index_status: entry[0] ?? " ",
      worktree_status: entry[1] ?? " ",
      path: entry.slice(3)
    }));
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

  return {
    files: status,
    untracked_files: status
      .filter((file) => file.index_status === "?" && file.worktree_status === "?")
      .map((file) => file.path),
    staged_diff: staged.value,
    unstaged_diff: unstaged.value,
    staged_diff_truncated: staged.truncated,
    unstaged_diff_truncated: unstaged.truncated,
    max_diff_bytes: maxDiffBytes
  };
}
