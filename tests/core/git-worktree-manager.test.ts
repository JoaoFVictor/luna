import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanup,
  prepare
} from "../../src/core/git-worktree-manager.js";
import type { WorkspaceRecord } from "../../src/core/types.js";
import { gitInvocation, gitRepository } from "../fixtures/git-repo.js";

type GitCall = {
  cwd: string;
  args: readonly string[];
};

type MkdirCall = {
  path: string;
  options: { recursive: boolean; mode: number };
};

async function tempRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "luna-worktrees-"));
}

describe("git worktree manager", () => {
  it("fetches refs, verifies commits, creates a safe worktree, and validates HEAD", async () => {
    const workspaceRoot = await tempRoot();
    const runId = "20260618t150405z-octo-hello-pr-42-a1";
    const calls: GitCall[] = [];
    const mkdirCalls: MkdirCall[] = [];
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
            return `${gitInvocation.references.head_sha}\n`;
          }

          return "";
        },
        mkdir: async (targetPath, options) => {
          mkdirCalls.push({ path: targetPath, options });
        }
      });

      expect(record).toEqual({
        run_id: runId,
        path: expectedWorktreePath,
        preserved: true,
        reason: "created"
      });
      expect(mkdirCalls).toEqual([
        {
          path: path.dirname(expectedWorktreePath),
          options: { recursive: true, mode: 0o700 }
        }
      ]);
      expect(calls).toEqual([
        {
          cwd: gitRepository.path,
          args: ["fetch", gitRepository.remote, gitInvocation.base_ref]
        },
        {
          cwd: gitRepository.path,
          args: [
            "fetch",
            gitRepository.remote,
            `+refs/pull/${gitInvocation.pull_number}/head:refs/remotes/${gitRepository.remote}/pull/${gitInvocation.pull_number}/head`
          ]
        },
        {
          cwd: gitRepository.path,
          args: ["cat-file", "-e", `${gitInvocation.references.base_sha}^{commit}`]
        },
        {
          cwd: gitRepository.path,
          args: ["cat-file", "-e", `${gitInvocation.references.head_sha}^{commit}`]
        },
        {
          cwd: gitRepository.path,
          args: ["worktree", "add", expectedWorktreePath, gitInvocation.references.head_sha]
        },
        {
          cwd: expectedWorktreePath,
          args: ["rev-parse", "HEAD"]
        }
      ]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("fetches a non-main base_ref from the invocation", async () => {
    const workspaceRoot = await tempRoot();
    const calls: GitCall[] = [];

    try {
      await prepare({
        invocation: {
          ...gitInvocation,
          base_ref: "release/1.2"
        },
        repository: gitRepository,
        workspaceRoot,
        runId: "run-a1",
        runGit: async (cwd, args) => {
          calls.push({ cwd, args });

          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return `${gitInvocation.references.head_sha}\n`;
          }

          return "";
        },
        mkdir: async () => {}
      });

      expect(calls[0]).toEqual({
        cwd: gitRepository.path,
        args: ["fetch", gitRepository.remote, "release/1.2"]
      });
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

  it("refuses cleanup paths outside the workspace root", async () => {
    const workspaceRoot = await tempRoot();
    const outsideRecord: WorkspaceRecord = {
      run_id: "run-a1",
      path: path.join(path.dirname(workspaceRoot), "outside"),
      preserved: true,
      reason: "created"
    };

    try {
      await expect(
        cleanup({
          repositoryPath: gitRepository.path,
          workspaceRoot,
          workspaceRecord: outsideRecord,
          persistedWorkspaceRecord: outsideRecord,
          runGit: async () => ""
        })
      ).rejects.toMatchObject({ code: "path_security_violation" });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("refuses cleanup when a workspace path resolves outside the workspace root", async () => {
    const workspaceRoot = "/tmp/luna-workspaces";
    const workspaceRecord: WorkspaceRecord = {
      run_id: "run-a1",
      path: "/tmp/luna-workspaces/link/run-a1",
      preserved: true,
      reason: "created"
    };
    const calls: GitCall[] = [];

    await expect(
      cleanup({
        repositoryPath: gitRepository.path,
        workspaceRoot,
        workspaceRecord,
        persistedWorkspaceRecord: workspaceRecord,
        realpath: async (targetPath) => {
          if (targetPath === workspaceRoot) {
            return "/tmp/luna-workspaces-real";
          }

          if (targetPath === workspaceRecord.path) {
            return "/tmp/outside/run-a1";
          }

          return targetPath;
        },
        runGit: async (cwd, args) => {
          calls.push({ cwd, args });
          return `worktree ${workspaceRecord.path}\n`;
        }
      })
    ).rejects.toMatchObject({ code: "path_security_violation" });
    expect(calls).toEqual([]);
  });

  it("refuses cleanup when the persisted workspace.json record is missing", async () => {
    const workspaceRecord: WorkspaceRecord = {
      run_id: "run-a1",
      path: "/tmp/luna-worktrees/run-a1",
      preserved: true,
      reason: "created"
    };

    await expect(
      cleanup({
        repositoryPath: gitRepository.path,
        workspaceRoot: "/tmp/luna-worktrees",
        workspaceRecord,
        persistedWorkspaceRecord: undefined,
        runGit: async () => ""
      })
    ).rejects.toMatchObject({ code: "workspace_record_missing" });
  });

  it("refuses cleanup when persisted workspace.json path differs from memory", async () => {
    const workspaceRoot = await tempRoot();
    const workspaceRecord: WorkspaceRecord = {
      run_id: "run-a1",
      path: path.join(workspaceRoot, "run-a1"),
      preserved: true,
      reason: "created"
    };

    try {
      await expect(
        cleanup({
          repositoryPath: gitRepository.path,
          workspaceRoot,
          workspaceRecord,
          persistedWorkspaceRecord: {
            ...workspaceRecord,
            path: path.join(workspaceRoot, "other-run")
          },
          runGit: async () => ""
        })
      ).rejects.toMatchObject({ code: "workspace_record_mismatch" });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("refuses cleanup when run ID or preservation state differs from memory", async () => {
    const workspaceRoot = await tempRoot();
    const workspaceRecord: WorkspaceRecord = {
      run_id: "run-a1",
      path: path.join(workspaceRoot, "run-a1"),
      preserved: true,
      reason: "created"
    };

    try {
      await expect(
        cleanup({
          repositoryPath: gitRepository.path,
          workspaceRoot,
          workspaceRecord,
          persistedWorkspaceRecord: {
            ...workspaceRecord,
            run_id: "run-a2"
          },
          runGit: async () => ""
        })
      ).rejects.toMatchObject({ code: "workspace_record_mismatch" });

      await expect(
        cleanup({
          repositoryPath: gitRepository.path,
          workspaceRoot,
          workspaceRecord,
          persistedWorkspaceRecord: {
            ...workspaceRecord,
            preserved: false
          },
          runGit: async () => ""
        })
      ).rejects.toMatchObject({ code: "workspace_record_mismatch" });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("refuses cleanup when persisted workspace.json reason differs from memory", async () => {
    const workspaceRoot = await tempRoot();
    const workspaceRecord: WorkspaceRecord = {
      run_id: "run-a1",
      path: path.join(workspaceRoot, "run-a1"),
      preserved: true,
      reason: "created"
    };

    try {
      await expect(
        cleanup({
          repositoryPath: gitRepository.path,
          workspaceRoot,
          workspaceRecord,
          persistedWorkspaceRecord: {
            ...workspaceRecord,
            reason: "different"
          },
          runGit: async () => ""
        })
      ).rejects.toMatchObject({ code: "workspace_record_mismatch" });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("only removes a registered Git worktree and marks cleanup successful", async () => {
    const workspaceRoot = await tempRoot();
    const workspaceRecord: WorkspaceRecord = {
      run_id: "run-a1",
      path: path.join(workspaceRoot, "run-a1"),
      preserved: true,
      reason: "created"
    };
    const calls: GitCall[] = [];

    try {
      await mkdir(workspaceRecord.path, { recursive: true });

      const updated = await cleanup({
        repositoryPath: gitRepository.path,
        workspaceRoot,
        workspaceRecord,
        persistedWorkspaceRecord: workspaceRecord,
        runGit: async (cwd, args) => {
          calls.push({ cwd, args });

          if (args[0] === "worktree" && args[1] === "list") {
            return `worktree ${workspaceRecord.path}\nHEAD ${gitInvocation.references.head_sha}\nbranch refs/heads/main\n`;
          }

          return "";
        }
      });

      expect(calls).toEqual([
        {
          cwd: gitRepository.path,
          args: ["worktree", "list", "--porcelain"]
        },
        {
          cwd: gitRepository.path,
          args: ["worktree", "remove", workspaceRecord.path]
        }
      ]);
      expect(updated).toEqual({
        ...workspaceRecord,
        preserved: false,
        reason: "success_cleanup"
      });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("refuses cleanup when the path is not registered as a Git worktree", async () => {
    const workspaceRoot = await tempRoot();
    const workspaceRecord: WorkspaceRecord = {
      run_id: "run-a1",
      path: path.join(workspaceRoot, "run-a1"),
      preserved: true,
      reason: "created"
    };

    try {
      await mkdir(workspaceRecord.path, { recursive: true });

      await expect(
        cleanup({
          repositoryPath: gitRepository.path,
          workspaceRoot,
          workspaceRecord,
          persistedWorkspaceRecord: workspaceRecord,
          runGit: async (_cwd, args) => {
            if (args[0] === "worktree" && args[1] === "list") {
              return `worktree ${path.join(workspaceRoot, "other-run")}\n`;
            }

            return "";
          }
        })
      ).rejects.toMatchObject({ code: "workspace_record_missing" });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

});
