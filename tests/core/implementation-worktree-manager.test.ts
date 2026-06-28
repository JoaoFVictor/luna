import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { implementationBranchMetadata } from "../../src/capabilities/repository-change/branch.js";
import {
  prepareImplementationWorktree
} from "../../src/capabilities/repository-change/worktree.js";
import type { LocalTransactionJournalEntry } from "../../src/capabilities/repository-change/transaction-journal.js";
import type { RepositoryConfig } from "../../src/core/config/schemas.js";

type GitCall = {
  cwd: string;
  args: readonly string[];
};

const repository: RepositoryConfig = {
  id: "hello-world",
  provider: "github",
  owner: "octo-org",
  name: "hello-world",
  path: "/repos/hello-world",
  remote: "origin"
};

const subject = {
  key: "ABC-123",
  title: "Fix checkout validation"
};

async function tempRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "luna-implementation-worktrees-"));
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
  return implementationBranchMetadata({
    subject: branchSubject,
    branchPattern,
    runId,
    collisionAttempt,
    maxBranchLength
  }).branchName;
}

describe("implementation worktree manager", () => {
  it("fetches the base ref with argv, validates the branch with git, creates a feature branch, and records workspace metadata", async () => {
    const workspaceRoot = await tempRoot();
    const runId = "20260619t120000z-jira-abc-123";
    const baseSha = "1111111111111111111111111111111111111111";
    const calls: GitCall[] = [];
    const journalEntries: LocalTransactionJournalEntry[] = [];
    const expectedPath = path.join(workspaceRoot, repository.id, runId);
    const branch = expectedBranch({ runId });

    try {
      const record = await prepareImplementationWorktree({
        subject,
        repository,
        workspaceRoot,
        runId,
        baseRef: "main",
        appendJournalEntry: async (entry) => {
          journalEntries.push(entry);
        },
        now: () => new Date("2026-06-25T10:00:00.000Z"),
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

      expect(record).toMatchObject({
        operation_id: "repository-workspace.capture",
        run_id: runId,
        workspace_id: `${repository.id}:${runId}`,
        path: expectedPath,
        lifecycle: "active",
        repository_id: repository.id,
        base_ref: "main",
        base_sha: baseSha,
        branch
      });
      expect(calls).toContainEqual({
        cwd: repository.path,
        args: ["check-ref-format", "--branch", "main"]
      });
      expect(calls).toContainEqual({
        cwd: repository.path,
        args: ["worktree", "add", "-b", branch, expectedPath, "origin/main"]
      });
      expect(calls).toContainEqual({
        cwd: expectedPath,
        args: ["branch", "--show-current"]
      });
      expect(journalEntries.map((entry) => entry.phase)).toEqual([
        "started",
        "succeeded"
      ]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("fails missing run identity before creating a worktree", async () => {
    const workspaceRoot = await tempRoot();
    const calls: GitCall[] = [];

    try {
      await expect(
        prepareImplementationWorktree({
          subject,
          repository,
          workspaceRoot,
          runId: "",
          baseRef: "main",
          runGit: async (cwd, args) => {
            calls.push({ cwd, args });
            return "";
          }
        })
      ).rejects.toMatchObject({ code: "run_identity_missing" });

      expect(calls).toEqual([]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("journals rollback only after a post-create branch invariant failure", async () => {
    const workspaceRoot = await tempRoot();
    const runId = "run-a1";
    const branch = expectedBranch({ runId });
    const wrongBranch = "feature/wrong";
    const journalEntries: LocalTransactionJournalEntry[] = [];
    const expectedPath = path.join(workspaceRoot, repository.id, runId);

    try {
      await expect(
        prepareImplementationWorktree({
          subject,
          repository,
          workspaceRoot,
          runId,
          baseRef: "main",
          appendJournalEntry: async (entry) => {
            journalEntries.push(entry);
          },
          runGit: async (_cwd, args) => {
            if (args[0] === "rev-parse") {
              return "1111111111111111111111111111111111111111\n";
            }

            if (args[0] === "branch" && args[1] === "--show-current") {
              return `${wrongBranch}\n`;
            }

            return "";
          }
        })
      ).rejects.toMatchObject({ code: "branch_mismatch" });

      expect(journalEntries.at(-1)).toMatchObject({
        runId,
        phase: "rolled_back",
        resources: {
          worktreePath: expectedPath,
          repositoryPath: repository.path,
          branchName: branch
        },
        cleanup: {
          attempted: true,
          action: "remove_worktree"
        },
        originalFailure: {
          code: "branch_mismatch",
          message: expect.stringContaining(wrongBranch)
        }
      });
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
          .map((call) => call.args[3])
      ).toEqual([firstBranch, retryBranch]);
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

});
