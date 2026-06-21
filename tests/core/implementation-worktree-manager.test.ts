import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { implementationBranchMetadata } from "../../src/core/implementation-branch.js";
import {
  prepareImplementationWorktree
} from "../../src/core/implementation-worktree-manager.js";
import type { RepositoryConfig } from "../../src/core/types.js";

type GitCall = {
  cwd: string;
  args: readonly string[];
};

const repository: RepositoryConfig = {
  id: "swg-front-nuxt",
  provider: "github",
  owner: "swinggo-dev",
  name: "swg-front-nuxt",
  path: "/repos/swg-front-nuxt",
  remote: "origin"
};

const subject = {
  key: "ABC-123",
  title: "Fix checkout validation"
};

async function tempRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "luna-implementation-worktrees-"));
}

function normalizeSlugPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function expectedBranch({
  branchPattern = "feature/{slug}",
  runId,
  collisionAttempt = 1,
  maxBranchLength,
  branchSubject = subject
}: {
  branchPattern?: string;
  runId: string;
  collisionAttempt?: number;
  maxBranchLength?: number;
  branchSubject?: { key: string; title?: string };
}): string {
  const branchSeed = [
    normalizeSlugPart(branchSubject.key) || "subject",
    normalizeSlugPart(branchSubject.title ?? branchSubject.key)
  ]
    .filter((part, index, parts) => part !== "" && parts.indexOf(part) === index)
    .join("-");
  const runHash = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  const collisionSuffix = collisionAttempt === 1 ? "" : `-r${collisionAttempt}`;
  const suffix = `-${runHash}${collisionSuffix}`;
  const staticLength = branchPattern.length - "{slug}".length;
  const seedBudget =
    maxBranchLength === undefined
      ? branchSeed.length
      : maxBranchLength - staticLength - suffix.length;
  const truncatedSeed = branchSeed.slice(0, seedBudget).replace(/-+$/g, "");

  return branchPattern.replace("{slug}", `${truncatedSeed}${suffix}`);
}

describe("implementation worktree manager", () => {
  it("builds branch metadata with a literal run hash suffix and collision suffix", () => {
    expect(
      implementationBranchMetadata({
        subject,
        branchPattern: "luna/{slug}",
        runId: "run-a1"
      })
    ).toEqual({
      branchSeed: "abc-123-fix-checkout-validation",
      branchName: "luna/abc-123-fix-checkout-validation-ab8836ebf8cb",
      collisionAttempt: 1,
      collisionSuffix: ""
    });

    expect(
      implementationBranchMetadata({
        subject,
        branchPattern: "luna/{slug}",
        runId: "run-a1",
        collisionAttempt: 2
      })
    ).toMatchObject({
      branchName: "luna/abc-123-fix-checkout-validation-ab8836ebf8cb-r2",
      collisionSuffix: "-r2"
    });
  });

  it("rejects branch patterns with more than one slug placeholder", () => {
    expect(() =>
      implementationBranchMetadata({
        subject,
        branchPattern: "luna/{slug}/{slug}",
        runId: "run-a1"
      })
    ).toThrow(
      expect.objectContaining({
        code: "invalid_branch_pattern"
      })
    );
  });

  it("fetches the base ref with argv, validates the branch with git, creates a feature branch, and records workspace metadata", async () => {
    const workspaceRoot = await tempRoot();
    const runId = "20260619t120000z-jira-abc-123";
    const baseSha = "1111111111111111111111111111111111111111";
    const calls: GitCall[] = [];
    const expectedPath = path.join(workspaceRoot, repository.id, runId);
    const branch = expectedBranch({ runId });

    try {
      const record = await prepareImplementationWorktree({
        subject,
        repository,
        workspaceRoot,
        runId,
        baseRef: "main",
        runGit: async (cwd, args) => {
          calls.push({ cwd, args });

          if (args[0] === "rev-parse") {
            return `${baseSha}\n`;
          }

          if (args[0] === "branch" && args[1] === "--show-current") {
            return `${branch}\n`;
          }

          return "";
        }
      });

      expect(record).toEqual({
        run_id: runId,
        path: expectedPath,
        preserved: true,
        reason: "created",
        repository_id: repository.id,
        remote: "origin",
        base_ref: "main",
        base_sha: baseSha,
        branch
      });
      expect(calls).toEqual([
        {
          cwd: repository.path,
          args: ["check-ref-format", "--branch", "main"]
        },
        {
          cwd: repository.path,
          args: ["fetch", "origin", "main"]
        },
        {
          cwd: repository.path,
          args: ["rev-parse", "origin/main"]
        },
        {
          cwd: repository.path,
          args: ["check-ref-format", "--branch", branch]
        },
        {
          cwd: repository.path,
          args: ["worktree", "add", "-b", branch, expectedPath, "origin/main"]
        },
        {
          cwd: expectedPath,
          args: ["branch", "--show-current"]
        }
      ]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("preserves a stable hash derived from the full run id in the final branch name", async () => {
    const workspaceRoot = await tempRoot();
    const runId = "20260618t150405123z-implementation-jira-issue-a1-nonce";
    const branch = expectedBranch({ branchPattern: "luna/{slug}", runId });
    const sameTailDifferentRun = expectedBranch({
      branchPattern: "luna/{slug}",
      runId: "20260619t150405123z-implementation-jira-issue-a1-nonce"
    });

    try {
      const record = await prepareImplementationWorktree({
        subject,
        repository,
        workspaceRoot,
        runId,
        baseRef: "main",
        branchPattern: "luna/{slug}",
        runGit: async (_cwd, args) => {
          if (args[0] === "rev-parse") {
            return "1111111111111111111111111111111111111111\n";
          }

          if (args[0] === "branch" && args[1] === "--show-current") {
            return `${branch}\n`;
          }

          return "";
        }
      });

      expect(record.branch).toBe(branch);
      expect(record.branch).toMatch(/^luna\/abc-123-fix-checkout-validation-[0-9a-f]{12}$/);
      expect(record.branch).not.toContain("a1-nonce");
      expect(branch).not.toBe(sameTailDifferentRun);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("truncates the branch seed without truncating the hash suffix", async () => {
    const workspaceRoot = await tempRoot();
    const runId = "run-a1";
    const branchSubject = {
      key: "ABC-123",
      title: "Corrigir validação de checkout com documentos extras"
    };
    const branch = expectedBranch({
      runId,
      maxBranchLength: 35,
      branchSubject
    });

    try {
      const record = await prepareImplementationWorktree({
        subject: branchSubject,
        repository,
        workspaceRoot,
        runId,
        baseRef: "main",
        maxBranchLength: 35,
        runGit: async (_cwd, args) => {
          if (args[0] === "rev-parse") {
            return "1111111111111111111111111111111111111111\n";
          }

          if (args[0] === "branch" && args[1] === "--show-current") {
            return `${branch}\n`;
          }

          return "";
        }
      });

      expect(record.branch).toBe(branch);
      expect(record.branch).toHaveLength(35);
      expect(record.branch).toMatch(/^feature\/abc-123-[a-z0-9-]+-[0-9a-f]{12}$/);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("changes the retry suffix only after git worktree add reports a branch collision", async () => {
    const workspaceRoot = await tempRoot();
    const runId = "20260618t150405123z-implementation-jira-issue-a1-nonce";
    const calls: GitCall[] = [];
    const firstBranch = expectedBranch({ branchPattern: "luna/{slug}", runId });
    const retryBranch = expectedBranch({
      branchPattern: "luna/{slug}",
      runId,
      collisionAttempt: 2
    });
    let worktreeAttempts = 0;

    try {
      const record = await prepareImplementationWorktree({
        subject,
        repository,
        workspaceRoot,
        runId,
        baseRef: "main",
        branchPattern: "luna/{slug}",
        runGit: async (cwd, args) => {
          calls.push({ cwd, args });

          if (args[0] === "rev-parse") {
            return "1111111111111111111111111111111111111111\n";
          }

          if (args[0] === "worktree" && args[1] === "add") {
            worktreeAttempts += 1;

            if (worktreeAttempts === 1) {
              throw Object.assign(
                new Error("fatal: a branch named 'abc' already exists"),
                { stderr: "fatal: a branch named 'abc' already exists\n" }
              );
            }
          }

          if (args[0] === "branch" && args[1] === "--show-current") {
            return `${retryBranch}\n`;
          }

          return "";
        }
      });

      expect(record.branch).toBe(retryBranch);
      expect(
        calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "add")
      ).toEqual([
        {
          cwd: repository.path,
          args: [
            "worktree",
            "add",
            "-b",
            firstBranch,
            path.join(workspaceRoot, repository.id, runId),
            "origin/main"
          ]
        },
        {
          cwd: repository.path,
          args: [
            "worktree",
            "add",
            "-b",
            retryBranch,
            path.join(workspaceRoot, repository.id, runId),
            "origin/main"
          ]
        }
      ]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("does not probe local or remote refs before creating the branch", async () => {
    const workspaceRoot = await tempRoot();
    const calls: GitCall[] = [];
    const runId = "run-a1";
    const branch = expectedBranch({ runId });

    try {
      await prepareImplementationWorktree({
        subject,
        repository,
        workspaceRoot,
        runId,
        baseRef: "main",
        runGit: async (cwd, args) => {
          calls.push({ cwd, args });

          if (args[0] === "rev-parse") {
            return "1111111111111111111111111111111111111111\n";
          }

          if (args[0] === "branch" && args[1] === "--show-current") {
            return `${branch}\n`;
          }

          return "";
        }
      });

      expect(calls.some((call) => call.args[0] === "for-each-ref")).toBe(false);
      expect(calls.some((call) => call.args[0] === "ls-remote")).toBe(false);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("throws after exhausting bounded branch creation collision retries", async () => {
    const workspaceRoot = await tempRoot();
    const runId = "20260618t150405123z-implementation-jira-issue-a1-nonce";
    const attemptedBranches: string[] = [];

    try {
      await expect(
        prepareImplementationWorktree({
          subject,
          repository,
          workspaceRoot,
          runId,
          baseRef: "main",
          branchPattern: "luna/{slug}",
          runGit: async (_cwd, args) => {
            if (args[0] === "rev-parse") {
              return "1111111111111111111111111111111111111111\n";
            }

            if (args[0] === "worktree" && args[1] === "add") {
              attemptedBranches.push(String(args[3]));
              throw Object.assign(
                new Error("fatal: a branch named 'abc' already exists"),
                { stderr: "fatal: a branch named 'abc' already exists\n" }
              );
            }

            return "";
          }
        })
      ).rejects.toMatchObject({ code: "branch_collision_retry_exhausted" });

      expect(attemptedBranches).toEqual([1, 2, 3, 4, 5].map((attempt) =>
        expectedBranch({
          branchPattern: "luna/{slug}",
          runId,
          collisionAttempt: attempt
        })
      ));
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("does not retry worktree creation errors that are not branch collisions", async () => {
    const workspaceRoot = await tempRoot();
    const runId = "20260618t150405123z-implementation-jira-issue-a1-nonce";
    const permissionError = new Error("permission denied");
    let worktreeAttempts = 0;

    try {
      await expect(
        prepareImplementationWorktree({
          subject,
          repository,
          workspaceRoot,
          runId,
          baseRef: "main",
          branchPattern: "luna/{slug}",
          runGit: async (_cwd, args) => {
            if (args[0] === "rev-parse") {
              return "1111111111111111111111111111111111111111\n";
            }

            if (args[0] === "worktree" && args[1] === "add") {
              worktreeAttempts += 1;
              throw permissionError;
            }

            return "";
          }
        })
      ).rejects.toBe(permissionError);

      expect(worktreeAttempts).toBe(1);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("rejects branch patterns whose run suffix cannot fit max branch length", async () => {
    const workspaceRoot = await tempRoot();

    try {
      await expect(
        prepareImplementationWorktree({
          subject,
          repository,
          workspaceRoot,
          runId: "20260618t150405123z-implementation-jira-issue-a1-nonce",
          baseRef: "main",
          branchPattern: "luna/{slug}",
          maxBranchLength: 10,
          runGit: async (_cwd, args) => {
            if (args[0] === "rev-parse") {
              return "1111111111111111111111111111111111111111\n";
            }

            return "";
          }
        })
      ).rejects.toMatchObject({ code: "invalid_branch_length" });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("rejects an invalid base ref before fetch or worktree creation", async () => {
    const workspaceRoot = await tempRoot();
    const calls: GitCall[] = [];

    try {
      await expect(
        prepareImplementationWorktree({
          subject,
          repository,
          workspaceRoot,
          runId: "run-a1",
          baseRef: "main:refs/heads/pwn",
          runGit: async (cwd, args) => {
            calls.push({ cwd, args });

            if (args[0] === "check-ref-format") {
              throw new Error("invalid branch");
            }

            return "";
          }
        })
      ).rejects.toMatchObject({ code: "invalid_base_ref" });

      expect(calls).toEqual([
        {
          cwd: repository.path,
          args: ["check-ref-format", "--branch", "main:refs/heads/pwn"]
        }
      ]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("rejects worktree paths outside the workspace root", async () => {
    const workspaceRoot = await tempRoot();

    try {
      await expect(
        prepareImplementationWorktree({
          subject,
          repository: {
            ...repository,
            id: "../outside"
          },
          workspaceRoot,
          runId: "run-a1",
          baseRef: "main",
          runGit: async () => ""
        })
      ).rejects.toMatchObject({ code: "path_security_violation" });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
