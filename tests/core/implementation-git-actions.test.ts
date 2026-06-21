import { describe, expect, it } from "vitest";
import {
  commitChanges,
  openPullRequest,
  pushBranch
} from "../../src/core/implementation-git-actions.js";
import type {
  CommitChangesArtifact,
  PullRequestArtifact,
  PushBranchArtifact,
  ValidationResult
} from "../../src/core/types.js";
import type { LocalTransactionJournalEntry } from "../../src/core/local-transaction-journal.js";
import type { WorktreeDiff } from "../../src/core/worktree-diff-collector.js";

type GitCall = {
  cwd: string;
  args: readonly string[];
};

type GhCall = {
  cwd: string;
  args: readonly string[];
};

const cwd = "/repo/worktree";
const repositoryPath = "/repo/source";
const indexPath = "/repo/worktree/.git/index";
const branch = "feature/abc-123-fix-checkout-validation";
const remote = "origin";
const baseSha = "1111111111111111111111111111111111111111";
const runId = "run-123";
const expectedRemoteUrls = [
  "git@github.com:swinggo-dev/swg-front-nuxt.git",
  "https://github.com/swinggo-dev/swg-front-nuxt.git"
];
const commitMessage = "ABC-123: Fix checkout validation";

const passedValidation: ValidationResult = { passed: true };
const failedValidation: ValidationResult = { passed: false };
const accepted = { status: "accepted" };
const rejected = { status: "rejected" };

const nonEmptyDiff: WorktreeDiff = {
  files: [
    {
      path: "src/checkout.ts",
      status: "modified",
      index_status: " ",
      worktree_status: "M"
    }
  ],
  untracked_files: [],
  untracked_summaries: [],
  staged_diff: "",
  unstaged_diff: "diff --git a/src/checkout.ts b/src/checkout.ts\n+fix\n",
  staged_diff_truncated: false,
  unstaged_diff_truncated: false,
  max_diff_bytes: 1000
};

const emptyDiff: WorktreeDiff = {
  ...nonEmptyDiff,
  files: [],
  unstaged_diff: ""
};

function createRunGit({
  currentBranch = branch,
  remoteUrl = "git@github.com:swinggo-dev/swg-front-nuxt.git",
  baseAncestor = true,
  baseAncestorError,
  hasPreExistingStagedChanges = false,
  commitError,
  resetError
}: {
  currentBranch?: string;
  remoteUrl?: string;
  baseAncestor?: boolean;
  baseAncestorError?: unknown;
  hasPreExistingStagedChanges?: boolean;
  commitError?: unknown;
  resetError?: unknown;
} = {}): { calls: GitCall[]; runGit: (cwd: string, args: readonly string[]) => Promise<string> } {
  const calls: GitCall[] = [];

  return {
    calls,
    runGit: async (callCwd, args) => {
      calls.push({ cwd: callCwd, args });

      if (args[0] === "branch" && args[1] === "--show-current") {
        return `${currentBranch}\n`;
      }

      if (args[0] === "remote" && args[1] === "get-url") {
        return `${remoteUrl}\n`;
      }

      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        if (baseAncestorError !== undefined) {
          throw baseAncestorError;
        }

        if (!baseAncestor) {
          throw Object.assign(new Error("base is not ancestor"), {
            code: "git_command_failed",
            cause: {
              code: 1,
              killed: false,
              signal: null
            }
          });
        }

        return "";
      }

      if (args[0] === "rev-parse" && args[1] === "--git-path") {
        return `${indexPath}\n`;
      }

      if (args[0] === "diff" && args[1] === "--cached") {
        if (hasPreExistingStagedChanges) {
          throw gitCommandError({
            message: "Git command failed: git diff --cached --quiet --exit-code",
            code: 1
          });
        }

        return "";
      }

      if (args[0] === "commit") {
        if (commitError !== undefined) {
          throw commitError;
        }

        return "";
      }

      if (args[0] === "reset") {
        if (resetError !== undefined) {
          throw resetError;
        }

        return "";
      }

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "2222222222222222222222222222222222222222\n";
      }

      return "";
    }
  };
}

function gitCommandError({
  message,
  code,
  stdout = "",
  stderr = ""
}: {
  message: string;
  code: number;
  stdout?: string;
  stderr?: string;
}): Error {
  return Object.assign(new Error(message), {
    code: "git_command_failed",
    cause: {
      code,
      stdout,
      stderr
    }
  });
}

function commitInput(overrides: Partial<Parameters<typeof commitChanges>[0]> = {}) {
  const { runGit } = createRunGit();

  return {
    enabled: true,
    cwd,
    validation: passedValidation,
    acceptance: accepted,
    diff: nonEmptyDiff,
    branch,
    remote,
    baseSha,
    branchPattern: "feature/{slug}",
    expectedRemoteUrls,
    message: commitMessage,
    runGit,
    ...overrides
  };
}

describe("implementation git actions", () => {
  describe("commitChanges", () => {
    it("skips when disabled", async () => {
      await expect(commitChanges(commitInput({ enabled: false }))).resolves.toEqual({
        enabled: false,
        skipped: true,
        reason: "disabled"
      });
    });

    it("skips when validation failed", async () => {
      const { calls, runGit } = createRunGit();

      const result = await commitChanges(
        commitInput({ validation: failedValidation, runGit })
      );

      expect(result).toEqual({
        enabled: true,
        skipped: true,
        reason: "validation_failed"
      });
      expect(calls).toEqual([]);
    });

    it("skips when acceptance was rejected", async () => {
      await expect(
        commitChanges(commitInput({ acceptance: rejected }))
      ).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "acceptance_rejected"
      });
    });

    it("skips when the worktree diff is empty", async () => {
      await expect(commitChanges(commitInput({ diff: emptyDiff }))).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "empty_diff"
      });
    });

    it("skips when the current branch differs from the registered worktree branch", async () => {
      const { calls, runGit } = createRunGit({ currentBranch: "feature/other" });

      await expect(commitChanges(commitInput({ runGit }))).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "branch_mismatch"
      });
      expect(calls).toEqual([
        { cwd, args: ["branch", "--show-current"] }
      ]);
    });

    it("skips when the branch does not match the configured feature pattern", async () => {
      const { calls, runGit } = createRunGit({ currentBranch: "bugfix/abc-123" });

      await expect(
        commitChanges(commitInput({ branch: "bugfix/abc-123", runGit }))
      ).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "branch_pattern_mismatch"
      });
      expect(calls).toEqual([
        { cwd, args: ["branch", "--show-current"] }
      ]);
    });

    it("skips when the remote URL no longer matches the expected repository", async () => {
      const { calls, runGit } = createRunGit({
        remoteUrl: "git@github.com:someone/else.git"
      });

      await expect(commitChanges(commitInput({ runGit }))).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "remote_url_mismatch"
      });
      expect(calls).toEqual([
        { cwd, args: ["branch", "--show-current"] },
        { cwd, args: ["remote", "get-url", remote] }
      ]);
    });

    it("skips when the recorded base is not an ancestor of HEAD", async () => {
      const { calls, runGit } = createRunGit({ baseAncestor: false });

      await expect(commitChanges(commitInput({ runGit }))).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "base_ancestry_mismatch"
      });
      expect(calls).toEqual([
        { cwd, args: ["branch", "--show-current"] },
        { cwd, args: ["remote", "get-url", remote] },
        { cwd, args: ["merge-base", "--is-ancestor", baseSha, "HEAD"] }
      ]);
    });

    it("throws when the base ancestry check fails for infrastructure reasons", async () => {
      const baseAncestorError = Object.assign(new Error("git timed out"), {
        code: "git_command_failed",
        cause: {
          code: null,
          killed: true,
          signal: "SIGTERM"
        }
      });
      const { calls, runGit } = createRunGit({ baseAncestorError });

      await expect(commitChanges(commitInput({ runGit }))).rejects.toBe(
        baseAncestorError
      );
      expect(calls).toEqual([
        { cwd, args: ["branch", "--show-current"] },
        { cwd, args: ["remote", "get-url", remote] },
        { cwd, args: ["merge-base", "--is-ancestor", baseSha, "HEAD"] }
      ]);
    });

    it("does not run git add or git commit after a failed gate", async () => {
      const { calls, runGit } = createRunGit({
        remoteUrl: "git@github.com:someone/else.git"
      });

      await commitChanges(commitInput({ runGit }));

      expect(calls.map((call) => call.args[0])).not.toContain("add");
      expect(calls.map((call) => call.args[0])).not.toContain("commit");
    });

    it("runs scoped git add and git commit -m on success", async () => {
      const { calls, runGit } = createRunGit();

      await expect(commitChanges(commitInput({ runGit }))).resolves.toEqual({
        enabled: true,
        skipped: false,
        branch,
        commit_sha: "2222222222222222222222222222222222222222"
      });
      expect(calls).toEqual([
        { cwd, args: ["branch", "--show-current"] },
        { cwd, args: ["remote", "get-url", remote] },
        { cwd, args: ["merge-base", "--is-ancestor", baseSha, "HEAD"] },
        { cwd, args: ["rev-parse", "--git-path", "index"] },
        { cwd, args: ["diff", "--cached", "--quiet", "--exit-code"] },
        { cwd, args: ["--literal-pathspecs", "add", "-A", "--", "src/checkout.ts"] },
        { cwd, args: ["commit", "-m", commitMessage] },
        { cwd, args: ["rev-parse", "HEAD"] }
      ]);
    });

    it("journals a succeeded terminal entry after a successful commit", async () => {
      const { runGit } = createRunGit();
      const journal: LocalTransactionJournalEntry[] = [];

      await expect(
        commitChanges(
          commitInput({
            runId,
            repositoryPath,
            appendJournalEntry: async (entry) => {
              journal.push(entry);
            },
            now: () => new Date("2026-06-20T12:00:00.000Z"),
            runGit
          })
        )
      ).resolves.toMatchObject({
        enabled: true,
        skipped: false,
        commit_sha: "2222222222222222222222222222222222222222"
      });
      expect(journal.map((entry) => `${entry.operation}.${entry.phase}`)).toEqual([
        "commit_stage.started",
        "commit_stage.succeeded"
      ]);
      expect(journal.at(-1)).toMatchObject({
        runId,
        operation: "commit_stage",
        phase: "succeeded",
        timestamp: "2026-06-20T12:00:00.000Z",
        resources: { worktreePath: cwd, repositoryPath, indexPath },
        cleanup: {
          attempted: false,
          branchRemovalAllowed: false
        },
        indexRestoreStrategy: "reset_to_pre_operation_index"
      });
    });

    it("aborts before staging when the index already has staged changes", async () => {
      const { calls, runGit } = createRunGit({
        hasPreExistingStagedChanges: true
      });

      await expect(commitChanges(commitInput({ runGit }))).rejects.toMatchObject({
        kind: "pre_existing_staged_changes",
        command: "git",
        args: ["diff", "--cached", "--quiet", "--exit-code"],
        exitCode: 1,
        timedOut: false
      });
      expect(calls).toEqual([
        { cwd, args: ["branch", "--show-current"] },
        { cwd, args: ["remote", "get-url", remote] },
        { cwd, args: ["merge-base", "--is-ancestor", baseSha, "HEAD"] },
        { cwd, args: ["rev-parse", "--git-path", "index"] },
        { cwd, args: ["diff", "--cached", "--quiet", "--exit-code"] }
      ]);
    });

    it("restores the index and journals rollback when commit hooks fail", async () => {
      const commitError = gitCommandError({
        message: "Git command failed: git commit -m ABC-123: Fix checkout validation",
        code: 1,
        stderr: "pre-commit hook failed"
      });
      const { calls, runGit } = createRunGit({ commitError });
      const journal: LocalTransactionJournalEntry[] = [];

      await expect(
        commitChanges(
          commitInput({
            runId,
            repositoryPath,
            appendJournalEntry: async (entry) => {
              journal.push(entry);
            },
            now: () => new Date("2026-06-20T12:00:00.000Z"),
            runGit
          })
        )
      ).rejects.toMatchObject({
        kind: "unknown",
        stderrSummary: "pre-commit hook failed"
      });
      expect(calls).toEqual([
        { cwd, args: ["branch", "--show-current"] },
        { cwd, args: ["remote", "get-url", remote] },
        { cwd, args: ["merge-base", "--is-ancestor", baseSha, "HEAD"] },
        { cwd, args: ["rev-parse", "--git-path", "index"] },
        { cwd, args: ["diff", "--cached", "--quiet", "--exit-code"] },
        { cwd, args: ["--literal-pathspecs", "add", "-A", "--", "src/checkout.ts"] },
        { cwd, args: ["commit", "-m", commitMessage] },
        { cwd, args: ["reset", "--mixed", "HEAD"] }
      ]);
      expect(journal.map((entry) => `${entry.operation}.${entry.phase}`)).toEqual([
        "commit_stage.started",
        "commit_stage.failed",
        "commit_stage.rolled_back"
      ]);
      expect(journal).toEqual([
        expect.objectContaining({
          runId,
          operation: "commit_stage",
          phase: "started",
          timestamp: "2026-06-20T12:00:00.000Z",
          resources: { worktreePath: cwd, repositoryPath, indexPath },
          cleanup: {
            attempted: false,
            branchRemovalAllowed: false
          },
          indexRestoreStrategy: "reset_to_pre_operation_index"
        }),
        expect.objectContaining({
          phase: "failed",
          cleanup: {
            attempted: false,
            branchRemovalAllowed: false
          },
          originalFailure: {
            code: "unknown",
            message: "Git command failed: git commit -m ABC-123: Fix checkout validation"
          }
        }),
        expect.objectContaining({
          phase: "rolled_back",
          cleanup: {
            attempted: true,
            action: "restore_index",
            branchRemovalAllowed: false
          },
          originalFailure: {
            code: "unknown",
            message: "Git command failed: git commit -m ABC-123: Fix checkout validation"
          }
        })
      ]);
    });

    it("restores the index when git add fails after partial staging", async () => {
      const addError = gitCommandError({
        message: "Git command failed: git add",
        code: 128,
        stderr: "fatal: pathspec failed"
      });
      const calls: GitCall[] = [];
      const runGit = async (callCwd: string, args: readonly string[]) => {
        calls.push({ cwd: callCwd, args });

        if (args[0] === "branch" && args[1] === "--show-current") {
          return `${branch}\n`;
        }

        if (args[0] === "remote" && args[1] === "get-url") {
          return "git@github.com:swinggo-dev/swg-front-nuxt.git\n";
        }

        if (args[0] === "rev-parse" && args[1] === "--git-path") {
          return `${indexPath}\n`;
        }

        if (args[0] === "diff" && args[1] === "--cached") {
          return "";
        }

        if (args[0] === "--literal-pathspecs") {
          throw addError;
        }

        return "";
      };
      const journal: LocalTransactionJournalEntry[] = [];

      await expect(
        commitChanges(
          commitInput({
            runId,
            appendJournalEntry: async (entry) => {
              journal.push(entry);
            },
            runGit
          })
        )
      ).rejects.toMatchObject({
        kind: "unknown",
        stderrSummary: "fatal: pathspec failed"
      });
      expect(calls.map((call) => call.args[0])).toContain("reset");
      expect(journal.map((entry) => entry.phase)).toEqual([
        "started",
        "failed",
        "rolled_back"
      ]);
    });

    it("restores the index even when failed journal append fails", async () => {
      const commitError = gitCommandError({
        message: "Git command failed: git commit -m ABC-123: Fix checkout validation",
        code: 1,
        stderr: "pre-commit hook failed"
      });
      const { calls, runGit } = createRunGit({ commitError });
      let appendAttempts = 0;

      await expect(
        commitChanges(
          commitInput({
            runId,
            appendJournalEntry: async () => {
              appendAttempts += 1;
              if (appendAttempts === 2) {
                throw new Error("journal failed");
              }
            },
            runGit
          })
        )
      ).rejects.toMatchObject({
        kind: "unknown",
        stderrSummary: "pre-commit hook failed"
      });
      expect(calls).toContainEqual({ cwd, args: ["reset", "--mixed", "HEAD"] });
      expect(appendAttempts).toBe(3);
    });

    it("does not mask the original git failure when rollback journal append fails", async () => {
      const commitError = gitCommandError({
        message: "Git command failed: git commit -m ABC-123: Fix checkout validation",
        code: 1,
        stderr: "pre-commit hook failed"
      });
      const { calls, runGit } = createRunGit({ commitError });
      let appendAttempts = 0;

      await expect(
        commitChanges(
          commitInput({
            runId,
            appendJournalEntry: async () => {
              appendAttempts += 1;
              if (appendAttempts === 3) {
                throw new Error("rollback journal failed");
              }
            },
            runGit
          })
        )
      ).rejects.toMatchObject({
        kind: "unknown",
        stderrSummary: "pre-commit hook failed"
      });
      expect(calls).toContainEqual({ cwd, args: ["reset", "--mixed", "HEAD"] });
      expect(appendAttempts).toBe(3);
    });

    it("journals cleanup failure when index restore fails", async () => {
      const commitError = gitCommandError({
        message: "Git command failed: git commit -m ABC-123: Fix checkout validation",
        code: 1,
        stderr: "pre-commit hook failed"
      });
      const resetError = gitCommandError({
        message: "Git command failed: git reset --mixed HEAD",
        code: 128,
        stderr: "fatal: reset failed"
      });
      const { runGit } = createRunGit({ commitError, resetError });
      const journal: LocalTransactionJournalEntry[] = [];

      await expect(
        commitChanges(
          commitInput({
            runId,
            appendJournalEntry: async (entry) => {
              journal.push(entry);
            },
            runGit
          })
        )
      ).rejects.toMatchObject({
        kind: "unknown",
        stderrSummary: "pre-commit hook failed"
      });
      expect(journal.at(-1)).toMatchObject({
        phase: "rolled_back",
        cleanup: {
          attempted: true,
          action: "restore_index",
          branchRemovalAllowed: false
        },
        cleanupFailure: {
          code: "unknown",
          message: "Git command failed: git reset --mixed HEAD"
        }
      });
    });

    it("throws a normalized GitFailure when commit fails because git identity is missing", async () => {
      const commitError = gitCommandError({
        message: "Git command failed: git commit -m ABC-123: Fix checkout validation",
        code: 128,
        stderr: "Author identity unknown\nfatal: unable to auto-detect email address"
      });
      const { runGit } = createRunGit({ commitError });

      await expect(
        commitChanges(commitInput({ runGit }))
      ).rejects.toMatchObject({
        kind: "missing_identity",
        command: "git",
        args: ["commit", "-m", "ABC-123:", "Fix", "checkout", "validation"],
        exitCode: 128,
        timedOut: false,
        stderrSummary: "Author identity unknown"
      });
    });

    it("throws a normalized GitFailure when there is nothing to commit after staging", async () => {
      const commitError = gitCommandError({
        message: "Git command failed: git commit -m ABC-123: Fix checkout validation",
        code: 1,
        stdout: "On branch feature/abc-123-fix-checkout-validation\nnothing to commit, working tree clean"
      });
      const { runGit } = createRunGit({ commitError });

      await expect(
        commitChanges(commitInput({ runGit }))
      ).rejects.toMatchObject({
        kind: "nothing_to_commit",
        command: "git",
        args: ["commit", "-m", "ABC-123:", "Fix", "checkout", "validation"],
        exitCode: 1,
        timedOut: false,
        stdoutSummary: "On branch feature/abc-123-fix-checkout-validation"
      });
    });

    it("passes stage paths as literal pathspecs", async () => {
      const { calls, runGit } = createRunGit();
      const pathspecMagicDiff: WorktreeDiff = {
        ...nonEmptyDiff,
        files: [
          {
            path: ":(glob)*",
            status: "untracked",
            index_status: "?",
            worktree_status: "?",
            untracked_summary: {
              path: ":(glob)*",
              excerpt: {
                start_line: 1,
                end_line: 1,
                content: "literal"
              },
              truncated: false,
              bytes: 7,
              max_bytes: 1000
            }
          },
          {
            path: ".env.local",
            status: "untracked",
            index_status: "?",
            worktree_status: "?",
            untracked_summary: {
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
          }
        ],
        untracked_files: [":(glob)*", ".env.local"],
        untracked_summaries: [],
        staged_diff: "",
        unstaged_diff: ""
      };

      await expect(
        commitChanges(commitInput({ diff: pathspecMagicDiff, runGit }))
      ).resolves.toMatchObject({
        enabled: true,
        skipped: false
      });
      expect(calls).toContainEqual({
        cwd,
        args: ["--literal-pathspecs", "add", "-A", "--", ":(glob)*"]
      });
    });

    it("does not stage sensitive untracked files", async () => {
      const { calls, runGit } = createRunGit();
      const sensitiveOnlyDiff: WorktreeDiff = {
        ...nonEmptyDiff,
        files: [
          {
            path: ".env.local",
            status: "untracked",
            index_status: "?",
            worktree_status: "?",
            untracked_summary: {
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
          }
        ],
        untracked_files: [".env.local"],
        untracked_summaries: [
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
        ],
        staged_diff: "",
        unstaged_diff: ""
      };

      await expect(
        commitChanges(commitInput({ diff: sensitiveOnlyDiff, runGit }))
      ).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "sensitive_untracked_files"
      });
      expect(calls).toEqual([
        { cwd, args: ["branch", "--show-current"] },
        { cwd, args: ["remote", "get-url", remote] },
        { cwd, args: ["merge-base", "--is-ancestor", baseSha, "HEAD"] }
      ]);
    });
  });

  describe("pushBranch", () => {
    const committed: CommitChangesArtifact = {
      enabled: true,
      skipped: false,
      branch,
      commit_sha: "2222222222222222222222222222222222222222"
    };

    function pushInput(overrides: Partial<Parameters<typeof pushBranch>[0]> = {}) {
      const { runGit } = createRunGit();

      return {
        enabled: true,
        cwd,
        commit: committed,
        branch,
        remote,
        expectedRemoteUrls,
        runGit,
        ...overrides
      };
    }

    it("skips when disabled", async () => {
      await expect(pushBranch(pushInput({ enabled: false }))).resolves.toEqual({
        enabled: false,
        skipped: true,
        reason: "disabled"
      });
    });

    it("skips when no commit was created", async () => {
      await expect(
        pushBranch(pushInput({ commit: { enabled: true, skipped: true } }))
      ).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "no_commit"
      });
    });

    it("skips when the committed branch differs from the registered branch", async () => {
      const { calls, runGit } = createRunGit();

      await expect(
        pushBranch(
          pushInput({
            commit: { ...committed, branch: "feature/other" },
            runGit
          })
        )
      ).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "branch_mismatch"
      });
      expect(calls).toEqual([]);
    });

    it("skips when the current branch differs from the registered branch", async () => {
      const { calls, runGit } = createRunGit({ currentBranch: "feature/other" });

      await expect(pushBranch(pushInput({ runGit }))).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "branch_mismatch"
      });
      expect(calls).toEqual([
        { cwd, args: ["branch", "--show-current"] }
      ]);
    });

    it("skips when the remote URL no longer matches the expected repository", async () => {
      const { calls, runGit } = createRunGit({
        remoteUrl: "git@github.com:someone/else.git"
      });

      await expect(pushBranch(pushInput({ runGit }))).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "remote_url_mismatch"
      });
      expect(calls).toEqual([
        { cwd, args: ["branch", "--show-current"] },
        { cwd, args: ["remote", "get-url", remote] }
      ]);
    });

    it("does not run git push after a failed gate", async () => {
      const { calls, runGit } = createRunGit({ currentBranch: "feature/other" });

      await pushBranch(pushInput({ runGit }));

      expect(calls.map((call) => call.args[0])).not.toContain("push");
    });

    it("pushes HEAD to the registered branch ref on success", async () => {
      const { calls, runGit } = createRunGit();

      await expect(pushBranch(pushInput({ runGit }))).resolves.toEqual({
        enabled: true,
        skipped: false,
        remote,
        branch
      });
      expect(calls).toEqual([
        { cwd, args: ["branch", "--show-current"] },
        { cwd, args: ["remote", "get-url", remote] },
        { cwd, args: ["push", remote, `HEAD:refs/heads/${branch}`] }
      ]);
    });
  });

  describe("openPullRequest", () => {
    const pushed: PushBranchArtifact = {
      enabled: true,
      skipped: false,
      remote,
      branch
    };

    function prInput(
      overrides: Partial<Parameters<typeof openPullRequest>[0]> = {}
    ) {
      const calls: GhCall[] = [];

      return {
        input: {
          enabled: true,
          cwd,
          push: pushed,
          branch,
          provider: "github",
          baseRef: "main",
          draft: true,
          title: commitMessage,
          body: "Implements ABC-123.",
          runGh: async (callCwd: string, args: readonly string[]) => {
            calls.push({ cwd: callCwd, args });

            if (args[0] === "pr" && args[1] === "create") {
              return "https://github.com/swinggo-dev/swg-front-nuxt/pull/42\n";
            }

            return "";
          },
          ...overrides
        },
        calls
      };
    }

    it("skips when disabled", async () => {
      const { input } = prInput({ enabled: false });

      await expect(openPullRequest(input)).resolves.toEqual({
        enabled: false,
        skipped: true,
        reason: "disabled"
      });
    });

    it("skips when the branch was not pushed", async () => {
      const { input } = prInput({ push: { enabled: true, skipped: true } });

      await expect(openPullRequest(input)).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "no_push"
      });
    });

    it("skips when the provider is not github", async () => {
      const { input } = prInput({ provider: "gitlab" });

      await expect(openPullRequest(input)).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "provider_unsupported"
      });
    });

    it("skips when the base ref is missing", async () => {
      const { input } = prInput({ baseRef: "" });

      await expect(openPullRequest(input)).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "base_ref_missing"
      });
    });

    it("skips when the pushed branch differs from the registered branch", async () => {
      const { input, calls } = prInput({
        push: { ...pushed, branch: "feature/other" }
      });

      await expect(openPullRequest(input)).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "branch_mismatch"
      });
      expect(calls).toEqual([]);
    });

    it("skips when gh is not authenticated", async () => {
      const calls: GhCall[] = [];
      const { input } = prInput({
        runGh: async (callCwd, args) => {
          calls.push({ cwd: callCwd, args });
          throw new Error("not logged in");
        }
      });

      await expect(openPullRequest(input)).resolves.toEqual({
        enabled: true,
        skipped: true,
        reason: "gh_not_authenticated"
      });
      expect(calls).toEqual([{ cwd, args: ["auth", "status"] }]);
    });

    it("throws a coded error when GitHub PR creation fails after authentication", async () => {
      const cause = new Error("gh pr create failed");
      const { input, calls } = prInput({
        runGh: async (callCwd, args) => {
          calls.push({ cwd: callCwd, args });

          if (args[0] === "pr" && args[1] === "create") {
            throw cause;
          }

          return "";
        }
      });

      await expect(openPullRequest(input)).rejects.toMatchObject({
        code: "pull_request_create_failed",
        cause
      });
      expect(calls).toEqual([
        { cwd, args: ["auth", "status"] },
        {
          cwd,
          args: [
            "pr",
            "create",
            "--draft",
            "--base",
            "main",
            "--head",
            branch,
            "--title",
            commitMessage,
            "--body",
            "Implements ABC-123."
          ]
        }
      ]);
    });

    it("creates a draft GitHub PR against the configured base ref", async () => {
      const { input, calls } = prInput();

      await expect(openPullRequest(input)).resolves.toEqual({
        enabled: true,
        skipped: false,
        provider: "github",
        url: "https://github.com/swinggo-dev/swg-front-nuxt/pull/42"
      } satisfies PullRequestArtifact);
      expect(calls).toEqual([
        { cwd, args: ["auth", "status"] },
        {
          cwd,
          args: [
            "pr",
            "create",
            "--draft",
            "--base",
            "main",
            "--head",
            branch,
            "--title",
            commitMessage,
            "--body",
            "Implements ABC-123."
          ]
        }
      ]);
    });
  });
});
