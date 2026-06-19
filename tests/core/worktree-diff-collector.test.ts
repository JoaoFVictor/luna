import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
        {
          path: "src/staged.ts",
          status: "modified",
          index_status: "M",
          worktree_status: " "
        },
        {
          path: "src/unstaged.ts",
          status: "modified",
          index_status: " ",
          worktree_status: "M"
        },
        {
          path: "notes.txt",
          status: "untracked",
          index_status: "?",
          worktree_status: "?",
          untracked_summary: {
            path: "notes.txt",
            excerpt: {
              start_line: 1,
              end_line: 1,
              content: ""
            },
            truncated: false,
            bytes: 0,
            max_bytes: 1000
          }
        }
      ],
      untracked_files: ["notes.txt"],
      untracked_summaries: [
        {
          path: "notes.txt",
          excerpt: {
            start_line: 1,
            end_line: 1,
            content: ""
          },
          truncated: false,
          bytes: 0,
          max_bytes: 1000
        }
      ],
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
      },
      {
        cwd: "/repo/worktree",
        args: ["diff", "--cached", "--numstat", "-z"]
      },
      {
        cwd: "/repo/worktree",
        args: ["diff", "--numstat", "-z"]
      },
      {
        cwd: "/repo/worktree",
        args: ["diff", "--cached", "--raw", "-z"]
      },
      {
        cwd: "/repo/worktree",
        args: ["diff", "--raw", "-z"]
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
    expect(result.files.map((file) => file.path)).not.toContain("src/old.ts");
  });

  it("normalizes deleted files from porcelain status", async () => {
    const result = await collectWorktreeDiff({
      cwd: "/repo/worktree",
      maxDiffBytes: 1000,
      runGit: async (_cwd, args) => {
        if (args[0] === "status") {
          return [" D src/deleted.ts", ""].join("\0");
        }

        return "";
      }
    });

    expect(result.files).toEqual([
      {
        path: "src/deleted.ts",
        status: "deleted",
        index_status: " ",
        worktree_status: "D"
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
      expect(result.files[0]?.untracked_summary).toEqual(
        result.untracked_summaries[0]
      );
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
      expect(result.files[0]?.untracked_summary).toEqual(
        result.untracked_summaries[0]
      );
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

  it("marks binary, submodule, and large changed files from git metadata", async () => {
    const result = await collectWorktreeDiff({
      cwd: "/repo/worktree",
      maxDiffBytes: 8,
      runGit: async (_cwd, args) => {
        if (args[0] === "status") {
          return [
            "M  assets/logo.png",
            "M  vendor/lib",
            " M src/large.ts",
            ""
          ].join("\0");
        }

        if (args[0] === "diff" && args.includes("--numstat")) {
          if (args.includes("--cached")) {
            return ["-\t-\tassets/logo.png", "1\t1\tvendor/lib", ""].join("\0");
          }

          return ["20\t0\tsrc/large.ts", ""].join("\0");
        }

        if (args[0] === "diff" && args.includes("--raw")) {
          if (args.includes("--cached")) {
            return [
              ":100644 100644 1111111 2222222 M",
              "assets/logo.png",
              ":160000 160000 3333333 4444444 M",
              "vendor/lib",
              ""
            ].join("\0");
          }

          return [":100644 100644 5555555 6666666 M", "src/large.ts", ""].join(
            "\0"
          );
        }

        return "";
      }
    });

    expect(result.files.find((file) => file.path === "assets/logo.png")).toMatchObject({
      binary: true
    });
    expect(result.files.find((file) => file.path === "vendor/lib")).toMatchObject({
      is_submodule: true
    });
    expect(result.files.find((file) => file.path === "src/large.ts")).toMatchObject({
      is_large: true
    });
  });
});
