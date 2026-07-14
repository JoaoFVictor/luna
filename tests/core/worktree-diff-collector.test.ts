import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { collectWorktreeDiff } from "../../src/capabilities/git/diff/worktree-diff.js";
import { runGit, runGitBounded } from "../../src/capabilities/git/client.js";

describe("worktree diff collector", () => {
  it("rejects invalid diff byte budgets at the collection boundary", async () => {
    for (const maxDiffBytes of [-1, 0, Number.NaN, 4 * 1024 * 1024 + 1]) {
      await expect(collectWorktreeDiff({
        cwd: "/repo/worktree",
        maxDiffBytes,
        runGit: async () => ""
      })).rejects.toThrow("maxDiffBytes must be an integer");
    }
  });

  it("terminates a producing git process as soon as its stdout cap is reached", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "worktree-git-bounded-"));
    try {
      await runGit(cwd, ["init", "--quiet"]);
      await writeFile(join(cwd, "large.txt"), "x".repeat(2 * 1024 * 1024));
      await runGit(cwd, ["add", "large.txt"]);

      const output = await runGitBounded(cwd, ["show", ":large.txt"], 1_024);

      expect(output.truncated).toBe(true);
      expect(Buffer.byteLength(output.stdout, "utf8")).toBe(1_024);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

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
          omitted: true,
          omitted_reason: "unavailable_or_unsafe"
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

  it("bounds ten-thousand-file status and untracked summary fan-out with explicit audit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "worktree-diff-many-"));
    const entries = Array.from({ length: 10_050 }, (_, index) =>
      `?? generated/file-${index.toString().padStart(5, "0")}.txt`
    );
    try {
      const result = await collectWorktreeDiff({
        cwd,
        maxDiffBytes: 1_000,
        runGit: async (_cwd, args) => args[0] === "status"
          ? [...entries, ""].join("\0")
          : ""
      });

      expect(result.files).toHaveLength(10_000);
      expect(result.untracked_summaries).toHaveLength(1_000);
      expect(result.status_files_omitted_count).toBe(50);
      expect(result.untracked_files_omitted_count).toBe(9_000);
      expect(result.untracked_summary_bytes)
        .toBeLessThanOrEqual(result.max_untracked_summary_bytes);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an untracked path whose ancestor is swapped for a symlink", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "worktree-diff-root-"));
    const outside = await mkdtemp(join(tmpdir(), "worktree-diff-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "ancestor secret");
      await symlink(outside, join(cwd, "nested"));
      const result = await collectWorktreeDiff({
        cwd,
        maxDiffBytes: 1_000,
        runGit: async (_cwd, args) => args[0] === "status"
          ? ["?? nested/secret.txt", ""].join("\0")
          : ""
      });

      expect(result.untracked_summaries[0]).toEqual(expect.objectContaining({
        path: "nested/secret.txt",
        omitted: true,
        excerpt: expect.objectContaining({ content: "" })
      }));
      expect(JSON.stringify(result)).not.toContain("ancestor secret");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

});
