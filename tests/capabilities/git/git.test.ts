import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createGitCommitBuiltIn,
  createGitPushBranchBuiltIn,
  createGitStatusBuiltIn
} from "../../../src/capabilities/git/built-ins.js";
import { manifest } from "../../../src/capabilities/git/manifest.js";
import { manifest as repositoryWorkspaceManifest } from "../../../src/capabilities/repository-workspace/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { defaultBuiltInCatalog } from "../../../src/core/built-ins/catalog.js";
import {
  builtInStepNames as providerBuiltInStepNames,
  runBuiltInStep as runProviderBuiltInStep
} from "../../../src/providers/built-ins.js";
import type { BuiltInStepDependencies } from "../../../src/core/built-ins/types.js";
import type {
  GitCommitState,
  GitRepositoryPort,
  GitStatusResult
} from "../../../src/capabilities/git/contracts.js";

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
  it("declares replay-safe reads and explicit write retry policies", () => {
    const registry = createCapabilityRegistry([repositoryWorkspaceManifest, manifest]);
    const git = registry.get("git");

    expect(git.built_ins?.["git.status"]).toMatchObject({
      id: "git.status",
      required_ports: ["git.repository"],
      side_effect_policy: "git.status_read_policy"
    });
    expect(git.policies?.["git.status_read_policy"]).toMatchObject({
      side_effect_semantics: "read",
      side_effect_operation_ids: ["git.status"],
      retry_semantics: "replay_safe"
    });
    expect(git.built_ins?.["git.commit"]).toMatchObject({
      id: "git.commit",
      required_ports: ["git.repository"],
      side_effect_policy: "git.commit_side_effect"
    });
    expect(git.policies?.["git.commit_side_effect"]).toMatchObject({
      side_effect_semantics: "write",
      side_effect_operation_ids: ["git.commit"],
      idempotency_scope: "attempt",
      retry_semantics: "retry_requires_adoption"
    });
    expect(git.built_ins?.["git.push_branch"]).toMatchObject({
      id: "git.push_branch",
      required_ports: ["git.repository"],
      side_effect_policy: "git.push_branch_side_effect"
    });
    expect(git.policies?.["git.push_branch_side_effect"]).toMatchObject({
      side_effect_semantics: "write",
      side_effect_operation_ids: ["git.push_branch"],
      idempotency_scope: "external_resource",
      retry_semantics: "retry_forbidden"
    });
  });

  it("runs status as a replay-safe read over the captured workspace", async () => {
    const port: GitRepositoryPort = {
      status: vi.fn(async (): Promise<GitStatusResult> => ({
        operation_id: "git.status",
        workspace_id: "workspace-1",
        branch: "task/run-1",
        head_sha: "abc123",
        dirty: true,
        staged_paths: ["src/a.ts"],
        unstaged_paths: ["src/b.ts"],
        untracked_paths: []
      })),
      readCommitState: vi.fn(),
      commit: vi.fn(),
      pushBranch: vi.fn()
    };
    const builtIn = createGitStatusBuiltIn({ repository: port });

    await expect(
      builtIn.run({
        state,
        input: { operation_id: "git.status" }
      })
    ).resolves.toMatchObject({
      operation_id: "git.status",
      workspace_id: "workspace-1",
      dirty: true
    });
    expect(port.status).toHaveBeenCalledWith({
      operation_id: "git.status",
      workspace
    });
    expect(port.commit).not.toHaveBeenCalled();
    expect(port.pushBranch).not.toHaveBeenCalled();
  });

  it("derives git operation ids from the selected built-in for simple YAML nodes", async () => {
    const status = vi.fn<GitRepositoryPort["status"]>(async () => ({
      operation_id: "git.status",
      workspace_id: "workspace-1",
      branch: "task/run-1",
      head_sha: "abc123",
      dirty: false,
      staged_paths: [],
      unstaged_paths: [],
      untracked_paths: []
    }));
    const commit = vi.fn<GitRepositoryPort["commit"]>(async () => ({
      operation_id: "git.commit",
      workspace_id: "workspace-1",
      branch: "task/run-1",
      head_sha: "base123",
      commit_sha: "commit456",
      message: "Implement thing",
      adopted: false
    }));
    const pushBranch = vi.fn<GitRepositoryPort["pushBranch"]>(async () => ({
      operation_id: "git.push_branch",
      workspace_id: "workspace-1",
      branch: "task/run-1",
      remote: "origin",
      commit_sha: "commit456",
      pushed: true
    }));
    const port: GitRepositoryPort = {
      status,
      readCommitState: vi.fn(async () => undefined),
      commit,
      pushBranch
    };

    await expect(
      createGitStatusBuiltIn({ repository: port }).run({ state })
    ).resolves.toMatchObject({ operation_id: "git.status" });
    await expect(
      createGitCommitBuiltIn({ repository: port }).run({
        state,
        input: { message: "Implement thing" }
      })
    ).resolves.toMatchObject({ operation_id: "git.commit" });
    await expect(
      createGitPushBranchBuiltIn({ repository: port }).run({
        state,
        input: {
          branch: "task/run-1",
          remote: "origin",
          expected_commit_sha: "commit456"
        }
      })
    ).resolves.toMatchObject({ operation_id: "git.push_branch" });

    expect(status).toHaveBeenCalledWith({
      operation_id: "git.status",
      workspace
    });
    expect(commit).toHaveBeenCalledWith({
      operation_id: "git.commit",
      workspace,
      message: "Implement thing",
      expected_branch: "task/run-1",
      expected_head_sha: "abc123",
      expected_dirty_paths: []
    });
    expect(pushBranch).toHaveBeenCalledWith({
      operation_id: "git.push_branch",
      workspace,
      branch: "task/run-1",
      remote: "origin",
      expected_commit_sha: "commit456"
    });
  });

  it("reads commit state before writing and adopts a matching existing commit", async () => {
    const readCommitState = vi.fn<GitRepositoryPort["readCommitState"]>(
      async () => ({
        operation_id: "git.commit",
        workspace_id: "workspace-1",
        branch: "task/run-1",
        head_sha: "base123",
        commit_sha: "commit123",
        message: "Implement thing",
        paths: ["src/a.ts"]
      })
    );
    const port: GitRepositoryPort = {
      status: vi.fn(),
      readCommitState,
      commit: vi.fn(),
      pushBranch: vi.fn()
    };
    port.status = vi.fn(async () => cleanStatus);
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
      commit_sha: "commit123",
      adopted: true
    });
    expect(port.readCommitState).toHaveBeenCalledWith({
      operation_id: "git.commit",
      workspace,
      message: "Implement thing",
      paths: ["src/a.ts"],
      expected_branch: "task/run-1",
      expected_head_sha: "base123",
      expected_dirty_paths: []
    });
    expect(port.commit).not.toHaveBeenCalled();
  });

  it("does not adopt existing commits with different branch, head, message, or paths", async () => {
    const incompatibleStates: Array<Partial<GitCommitState>> = [
      { branch: "task/other" },
      { head_sha: "other-head" },
      { message: "Different message" },
      { paths: ["src/other.ts"] }
    ];

    for (const incompatible of incompatibleStates) {
      const port: GitRepositoryPort = {
        status: vi.fn(async () => cleanStatus),
        readCommitState: vi.fn<GitRepositoryPort["readCommitState"]>(async () => ({
          operation_id: "git.commit",
          workspace_id: "workspace-1",
          branch: "task/run-1",
          head_sha: "base123",
          commit_sha: "commit123",
          message: "Implement thing",
          paths: ["src/a.ts"],
          ...incompatible
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
      expect(port.commit).toHaveBeenCalled();
    }
  });

  it("adopts a commit already at HEAD on retry without writing again", async () => {
    const retryStatus = {
      ...cleanStatus,
      head_sha: "commit123"
    };
    const readCommitState = vi.fn<GitRepositoryPort["readCommitState"]>(
      async () => ({
        operation_id: "git.commit",
        workspace_id: "workspace-1",
        branch: "task/run-1",
        head_sha: "base123",
        commit_sha: "commit123",
        message: "Implement thing",
        paths: ["src/a.ts"]
      })
    );
    const commit = vi.fn<GitRepositoryPort["commit"]>(async () => {
      throw new Error("commit should not be called during adoption");
    });
    const port: GitRepositoryPort = {
      status: vi.fn(async () => retryStatus),
      readCommitState,
      commit,
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
    ).resolves.toEqual({
      operation_id: "git.commit",
      workspace_id: "workspace-1",
      branch: "task/run-1",
      head_sha: "base123",
      commit_sha: "commit123",
      message: "Implement thing",
      paths: ["src/a.ts"],
      adopted: true
    });
    expect(readCommitState).toHaveBeenCalledWith({
      operation_id: "git.commit",
      workspace,
      message: "Implement thing",
      paths: ["src/a.ts"],
      expected_branch: "task/run-1",
      expected_head_sha: "commit123",
      expected_dirty_paths: []
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("adopts commit-all retries and returns normalized existing paths", async () => {
    const retryStatus = {
      ...cleanStatus,
      head_sha: "commit123"
    };
    const port: GitRepositoryPort = {
      status: vi.fn(async () => retryStatus),
      readCommitState: vi.fn<GitRepositoryPort["readCommitState"]>(async () => ({
        operation_id: "git.commit",
        workspace_id: "workspace-1",
        branch: "task/run-1",
        head_sha: "base123",
        commit_sha: "commit123",
        message: "Implement thing",
        paths: ["src/b.ts", "src/a.ts", "src/a.ts"]
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
          message: "Implement thing"
        }
      })
    ).resolves.toMatchObject({
      operation_id: "git.commit",
      commit_sha: "commit123",
      paths: ["src/a.ts", "src/b.ts"],
      adopted: true
    });
    expect(port.commit).not.toHaveBeenCalled();
  });

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
    expect(port.commit).toHaveBeenCalledWith({
      operation_id: "git.commit",
      workspace,
      message: "Implement thing",
      paths: ["src/a.ts"],
      expected_branch: "task/run-1",
      expected_head_sha: "base123",
      expected_dirty_paths: ["src/a.ts"]
    });
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
    expect(port.commit).toHaveBeenCalledWith({
      operation_id: "git.commit",
      workspace,
      message: "Implement thing",
      paths: ["src/a.ts"],
      expected_branch: "task/run-1",
      expected_head_sha: "base123",
      expected_dirty_paths: []
    });
  });

  it("declares push as retry-forbidden instead of exposing retry state in YAML", async () => {
    expect(manifest.policies?.["git.push_branch_side_effect"]).toMatchObject({
      side_effect_operation_ids: ["git.push_branch"],
      retry_semantics: "retry_forbidden"
    });
    expect(
      manifest.built_ins?.["git.push_branch"].input_schema
    ).not.toMatchObject({
      properties: {
        previous_outcome: expect.anything()
      }
    });
  });

  it("pushes a branch through the repository port", async () => {
    const port: GitRepositoryPort = {
      status: vi.fn(),
      readCommitState: vi.fn(),
      commit: vi.fn(),
      pushBranch: vi.fn<GitRepositoryPort["pushBranch"]>(async () => ({
        operation_id: "git.push_branch",
        workspace_id: "workspace-1",
        branch: "task/run-1",
        remote: "origin",
        commit_sha: "commit456",
        pushed: true
      }))
    };
    const builtIn = createGitPushBranchBuiltIn({ repository: port });

    await expect(
      builtIn.run({
        state,
        input: {
          branch: "task/run-1",
          remote: "origin",
          expected_commit_sha: "commit456"
        }
      })
    ).resolves.toMatchObject({
      operation_id: "git.push_branch",
      pushed: true
    });
    expect(port.pushBranch).toHaveBeenCalledWith({
      operation_id: "git.push_branch",
      workspace,
      branch: "task/run-1",
      remote: "origin",
      expected_commit_sha: "commit456"
    });
  });

  it("executes git built-ins through core and provider catalogs", async () => {
    const status = vi.fn<GitRepositoryPort["status"]>(async () => ({
      operation_id: "git.status",
      workspace_id: "workspace-1",
      branch: "task/run-1",
      head_sha: "abc123",
      dirty: false,
      staged_paths: [],
      unstaged_paths: [],
      untracked_paths: []
    }));
    const port: GitRepositoryPort = {
      status,
      readCommitState: vi.fn(),
      commit: vi.fn(),
      pushBranch: vi.fn()
    };
    const dependencies = {
      git: { repository: port }
    } satisfies BuiltInStepDependencies;

    await expect(
      defaultBuiltInCatalog.runBuiltInStep({
        uses: "git.status",
        state,
        dependencies
      })
    ).resolves.toMatchObject({ operation_id: "git.status" });
    await expect(
      runProviderBuiltInStep({
        uses: "git.status",
        state,
        dependencies
      })
    ).resolves.toMatchObject({ operation_id: "git.status" });
    expect(defaultBuiltInCatalog.names).toContain("git.status");
    expect(providerBuiltInStepNames).toContain("git.status");
  });

  it("keeps git capability leaf files free of provider and change-request leaks", async () => {
    const repositoryRoot = process.cwd();
    const files = [
      "src/capabilities/git/manifest.ts",
      "src/capabilities/git/contracts.ts",
      "src/capabilities/git/built-ins.ts"
    ];
    const forbiddenPatterns = [
      /change-request|changeRequest|ChangeRequest/,
      /src\/providers|src\/core\/providers|@octokit|jira\.js|plane/i,
      /pull_request|merge_request|issue_url|github|jira|linear/i,
      /src\/core\/git|src\/core\/write-mode|simple-git/
    ];

    for (const file of files) {
      const source = await readFile(path.join(repositoryRoot, file), "utf8");

      for (const forbiddenPattern of forbiddenPatterns) {
        expect(source, `${file} contains ${forbiddenPattern}`).not.toMatch(
          forbiddenPattern
        );
      }
    }
  });
});
