import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepare } from "../../src/providers/github/worktree-manager.js";
import { githubPullRequestContextFrom } from "../../src/providers/github/pull-request-context.js";
import { gitInvocation, gitRepository } from "../fixtures/git-repo.js";

const pullRequest = githubPullRequestContextFrom(gitInvocation);
const pullNumber = pullRequest.pull_number;
const headSha = pullRequest.references.head_sha;

type GitCall = {
  cwd: string;
  args: readonly string[];
};

async function tempRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "luna-worktrees-"));
}

describe("git worktree manager", () => {
  it("fetches refs, verifies commits, creates a safe worktree, and validates HEAD", async () => {
    const workspaceRoot = await tempRoot();
    const runId = "20260618t150405z-octo-hello-pr-42-a1";
    const calls: GitCall[] = [];
    const expectedWorktreePath = path.join(workspaceRoot, gitRepository.id, runId);

    try {
      const record = await prepare({
        invocation: gitInvocation,
        repository: gitRepository,
        workspaceRoot,
        runId,
        runGit: async (cwd, args) => {
          calls.push({ cwd, args });

          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return `${headSha}\n`;
          }

          return "";
        },
        mkdir: async () => {}
      });

      expect(record).toEqual({
        run_id: runId,
        path: expectedWorktreePath,
        preserved: true,
        reason: "created"
      });
      expect(calls).toContainEqual({
        cwd: gitRepository.path,
        args: [
          "worktree",
          "add",
          expectedWorktreePath,
          `refs/remotes/${gitRepository.remote}/pull/${pullNumber}/head`
        ]
      });
      expect(calls).toContainEqual({
        cwd: expectedWorktreePath,
        args: ["rev-parse", "HEAD"]
      });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("preserves operational Git failures while checking the expected head commit", async () => {
    const workspaceRoot = await tempRoot();
    const operationalFailure = Object.assign(new Error("git is unavailable"), {
      code: "git_command_failed",
      cause: {
        code: "EACCES"
      }
    });

    try {
      await expect(
        prepare({
          invocation: gitInvocation,
          repository: gitRepository,
          workspaceRoot,
          runId: "run-a1",
          runGit: async (_cwd, args) => {
            if (
              args[0] === "cat-file" &&
              args.at(-1) === `${headSha}^{commit}`
            ) {
              throw operationalFailure;
            }

            return "";
          },
          mkdir: async () => {}
        })
      ).rejects.toBe(operationalFailure);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
  it("removes the created worktree before throwing when HEAD differs from the expected SHA", async () => {
    const workspaceRoot = await tempRoot();
    const calls: GitCall[] = [];
    const runId = "run-a1";
    const expectedWorktreePath = path.join(workspaceRoot, gitRepository.id, runId);

    try {
      await expect(
        prepare({
          invocation: gitInvocation,
          repository: gitRepository,
          workspaceRoot,
          runId,
          runGit: async (cwd, args) => {
            calls.push({ cwd, args });

            if (args[0] === "rev-parse" && args[1] === "HEAD") {
              return "3333333333333333333333333333333333333333\n";
            }

            return "";
          },
          mkdir: async () => {}
        })
      ).rejects.toMatchObject({ code: "head_sha_mismatch" });
      expect(calls).toContainEqual({
        cwd: gitRepository.path,
        args: ["worktree", "remove", expectedWorktreePath]
      });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

});
