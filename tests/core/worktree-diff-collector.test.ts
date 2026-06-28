import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { collectWorktreeDiff } from "../../src/capabilities/git/diff/worktree-diff.js";

describe("worktree diff collector", () => {
  it("collects status, staged diff, and unstaged diff", async () => {
    const result = await collectWorktreeDiff({
      cwd: "/repo/worktree",
      maxDiffBytes: 1000,
      runGit: async (_cwd, args) => {
        if (args[0] === "status") {
          return [
            "M  src/staged.ts",
            " M src/unstaged.ts",
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

    expect(result).toMatchObject({
      files: [
        {
          path: "src/staged.ts",
          status: "modified"
        },
        {
          path: "src/unstaged.ts",
          status: "modified"
        }
      ],
      staged_diff:
        "diff --git a/src/staged.ts b/src/staged.ts\n+staged\n",
      unstaged_diff:
        "diff --git a/src/unstaged.ts b/src/unstaged.ts\n+unstaged\n"
    });
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

  it("parses porcelain rename entries without creating a phantom old-path file", async () => {
    const result = await collectWorktreeDiff({
      cwd: "/repo/worktree",
      maxDiffBytes: 1000,
      runGit: async (_cwd, args) => {
        if (args[0] === "status") {
          return ["R  src/new.ts", "src/old.ts", ""].join("\0");
        }

        return "";
      }
    });

    expect(result.files).toEqual([
      {
        path: "src/new.ts",
        previous_path: "src/old.ts",
        status: "renamed",
        index_status: "R",
        worktree_status: " "
      }
    ]);
  });

  it("summarizes untracked files with bounded excerpts and truncation metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "worktree-diff-"));

    try {
      await writeFile(join(cwd, "notes.txt"), "alpha\nbravo\ncharlie\n");

      const result = await collectWorktreeDiff({
        cwd,
        maxDiffBytes: 12,
        runGit: async (_cwd, args) => {
          if (args[0] === "status") {
            return ["?? notes.txt", ""].join("\0");
          }

          return "";
        }
      });

      expect(result.untracked_summaries).toEqual([
        {
          path: "notes.txt",
          excerpt: {
            start_line: 1,
            end_line: 2,
            content: "alpha\nbravo\n",
            truncated: true
          },
          truncated: true,
          bytes: 20,
          max_bytes: 12
        }
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not read untracked symlink targets when building excerpts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "worktree-diff-"));
    const outside = await mkdtemp(join(tmpdir(), "worktree-outside-"));

    try {
      await writeFile(join(outside, "secret.txt"), "outside secret target");
      await symlink(join(outside, "secret.txt"), join(cwd, "linked-secret.txt"));

      const result = await collectWorktreeDiff({
        cwd,
        maxDiffBytes: 1000,
        runGit: async (_cwd, args) => {
          if (args[0] === "status") {
            return ["?? linked-secret.txt", ""].join("\0");
          }

          return "";
        }
      });

      expect(result.untracked_summaries).toEqual([
        {
          path: "linked-secret.txt",
          excerpt: {
            start_line: 1,
            end_line: 1,
            content: ""
          },
          truncated: false,
          bytes: 0,
          max_bytes: 1000,
          symlink: true,
          omitted: true,
          omitted_reason: "symlink"
        }
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("omits sensitive untracked file contents from summaries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "worktree-diff-"));

    try {
      await writeFile(join(cwd, ".env.local"), "DATABASE_URL=postgres://secret\n");

      const result = await collectWorktreeDiff({
        cwd,
        maxDiffBytes: 1000,
        runGit: async (_cwd, args) => {
          if (args[0] === "status") {
            return ["?? .env.local", ""].join("\0");
          }

          return "";
        }
      });

      expect(result.untracked_summaries).toEqual([
        {
          path: ".env.local",
          excerpt: {
            start_line: 1,
            end_line: 1,
            content: ""
          },
          truncated: false,
          bytes: 31,
          max_bytes: 1000,
          omitted: true,
          omitted_reason: "sensitive_path"
        }
      ]);
      expect(JSON.stringify(result)).not.toContain("postgres://secret");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

});
