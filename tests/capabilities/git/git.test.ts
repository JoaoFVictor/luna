import { describe, expect, it, vi } from "vitest";
import {
  createGitCommitBuiltIn
} from "../../../src/capabilities/git/commit.js";
import type { GitRepositoryPort } from "../../../src/capabilities/git/contracts.js";

const workspace = {
  operation_id: "repository-workspace.capture",
  run_id: "run-1",
  repository_id: "repo-1",
  workspace_id: "workspace-1",
  path: "/repo/workspaces/run-1",
  preserved: true,
  reason: "active",
  lifecycle: "active",
  captured_at: "2026-06-26T10:00:00.000Z"
};

const state = {
  invocation: {},
  run: { run_id: "run-1" },
  workflow: { id: "workflow-1", mode: "trusted_local_write" },
  repository: { id: "repo-1" },
  workspace,
  steps: {}
};

const cleanStatus = {
  operation_id: "git.status" as const,
  workspace_id: "workspace-1",
  branch: "task/run-1",
  head_sha: "base123",
  dirty: false,
  staged_paths: [],
  unstaged_paths: [],
  untracked_paths: []
};

describe("git capability", () => {
  it("does not adopt current HEAD when target paths are still dirty", async () => {
    const dirtyStatus = {
      ...cleanStatus,
      dirty: true,
      unstaged_paths: ["src/a.ts"]
    };
    const port: GitRepositoryPort = {
      status: vi.fn(async () => dirtyStatus),
      readCommitState: vi.fn<GitRepositoryPort["readCommitState"]>(async () => ({
        operation_id: "git.commit",
        workspace_id: "workspace-1",
        branch: "task/run-1",
        head_sha: "parent000",
        commit_sha: "base123",
        message: "Implement thing",
        paths: ["src/a.ts"]
      })),
      commit: vi.fn<GitRepositoryPort["commit"]>(async () => ({
        operation_id: "git.commit",
        workspace_id: "workspace-1",
        branch: "task/run-1",
        head_sha: "base123",
        commit_sha: "commit456",
        message: "Implement thing",
        paths: ["src/a.ts"],
        adopted: false
      })),
      pushBranch: vi.fn()
    };

    await expect(
      createGitCommitBuiltIn({ repository: port }).run({
        state,
        input: {
          message: "Implement thing",
          paths: ["src/a.ts"]
        }
      })
    ).resolves.toMatchObject({
      commit_sha: "commit456",
      adopted: false
    });
    expect(port.commit).toHaveBeenCalledOnce();
  });

  it("allows retry adoption when only paths outside an explicit commit scope are dirty", async () => {
    const dirtyStatus = {
      ...cleanStatus,
      head_sha: "commit123",
      dirty: true,
      unstaged_paths: ["src/other.ts"]
    };
    const port: GitRepositoryPort = {
      status: vi.fn(async () => dirtyStatus),
      readCommitState: vi.fn<GitRepositoryPort["readCommitState"]>(async () => ({
        operation_id: "git.commit",
        workspace_id: "workspace-1",
        branch: "task/run-1",
        head_sha: "base123",
        commit_sha: "commit123",
        message: "Implement thing",
        paths: ["src/a.ts"]
      })),
      commit: vi.fn<GitRepositoryPort["commit"]>(async () => {
        throw new Error("commit should not be called during adoption");
      }),
      pushBranch: vi.fn()
    };

    await expect(
      createGitCommitBuiltIn({ repository: port }).run({
        state,
        input: {
          message: "Implement thing",
          paths: ["src/a.ts"]
        }
      })
    ).resolves.toMatchObject({
      commit_sha: "commit123",
      adopted: true
    });
    expect(port.commit).not.toHaveBeenCalled();
  });

  it("commits only after read-before-write finds no compatible commit", async () => {
    const readCommitState = vi.fn<GitRepositoryPort["readCommitState"]>(
      async () => undefined
    );
    const commit = vi.fn<GitRepositoryPort["commit"]>(async () => ({
      operation_id: "git.commit",
      workspace_id: "workspace-1",
      branch: "task/run-1",
      head_sha: "commit456",
      commit_sha: "commit456",
      message: "Implement thing",
      paths: ["src/a.ts"],
      adopted: false
    }));
    const port: GitRepositoryPort = {
      status: vi.fn(async () => cleanStatus),
      readCommitState,
      commit,
      pushBranch: vi.fn()
    };
    const builtIn = createGitCommitBuiltIn({ repository: port });

    await expect(
      builtIn.run({
        state,
        input: {
          operation_id: "git.commit",
          message: "Implement thing",
          paths: ["src/a.ts"]
        }
      })
    ).resolves.toMatchObject({
      operation_id: "git.commit",
      commit_sha: "commit456",
      adopted: false
    });
    expect(readCommitState).toHaveBeenCalledBefore(commit);
    expect(port.commit).toHaveBeenCalledOnce();
  });

});
