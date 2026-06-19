import { describe, expect, it } from "vitest";
import { collectWorktreeDiff } from "../../src/core/worktree-diff-collector.js";

type GitCall = {
  cwd: string;
  args: readonly string[];
};

describe("worktree diff collector", () => {
  it("collects status, staged diff, unstaged diff, and untracked summaries", async () => {
    const calls: GitCall[] = [];
    const result = await collectWorktreeDiff({
      cwd: "/repo/worktree",
      maxDiffBytes: 1000,
      runGit: async (cwd, args) => {
        calls.push({ cwd, args });

        if (args[0] === "status") {
          return [
            "M  src/staged.ts",
            " M src/unstaged.ts",
            "?? notes.txt",
            ""
          ].join("\0");
        }

        if (args[0] === "diff" && args.includes("--cached")) {
          return "diff --git a/src/staged.ts b/src/staged.ts\n+staged\n";
        }

        if (args[0] === "diff") {
          return "diff --git a/src/unstaged.ts b/src/unstaged.ts\n+unstaged\n";
        }

        return "";
      }
    });

    expect(result).toEqual({
      files: [
        { path: "src/staged.ts", index_status: "M", worktree_status: " " },
        { path: "src/unstaged.ts", index_status: " ", worktree_status: "M" },
        { path: "notes.txt", index_status: "?", worktree_status: "?" }
      ],
      untracked_files: ["notes.txt"],
      staged_diff:
        "diff --git a/src/staged.ts b/src/staged.ts\n+staged\n",
      unstaged_diff:
        "diff --git a/src/unstaged.ts b/src/unstaged.ts\n+unstaged\n",
      staged_diff_truncated: false,
      unstaged_diff_truncated: false,
      max_diff_bytes: 1000
    });
    expect(calls).toEqual([
      {
        cwd: "/repo/worktree",
        args: ["status", "--porcelain=v1", "-z"]
      },
      {
        cwd: "/repo/worktree",
        args: ["diff", "--cached", "--binary"]
      },
      {
        cwd: "/repo/worktree",
        args: ["diff", "--binary"]
      }
    ]);
  });

  it("records truncation metadata for staged and unstaged diffs", async () => {
    const result = await collectWorktreeDiff({
      cwd: "/repo/worktree",
      maxDiffBytes: 5,
      runGit: async (_cwd, args) => {
        if (args[0] === "status") {
          return "";
        }

        if (args[0] === "diff" && args.includes("--cached")) {
          return "abcdef";
        }

        return "123456";
      }
    });

    expect(result.staged_diff).toBe("abcde");
    expect(result.unstaged_diff).toBe("12345");
    expect(result.staged_diff_truncated).toBe(true);
    expect(result.unstaged_diff_truncated).toBe(true);
  });
});
