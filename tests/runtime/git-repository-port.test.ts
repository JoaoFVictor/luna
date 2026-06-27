import { describe, expect, it, vi } from "vitest";
import { createGitRepositoryPorts } from "../../src/runtime/git/repository-port.js";
import type { RepositoryWorkspaceRecord } from "../../src/core/repository-workspace/contracts.js";

const workspace: RepositoryWorkspaceRecord = {
  operation_id: "repository-workspace.capture",
  run_id: "run-1",
  repository_id: "repo-1",
  workspace_id: "workspace-1",
  path: "/tmp/luna-workspace",
  preserved: true,
  reason: "active",
  lifecycle: "active",
  captured_at: "2026-06-26T10:00:00.000Z"
};

function fakeRunGit(
  outputs: Record<string, string | string[]>
): ReturnType<typeof vi.fn<(cwd: string, args: readonly string[]) => Promise<string>>> {
  return vi.fn(async (_cwd, args) => {
    const key = args.join(" ");
    const output = outputs[key];
    if (Array.isArray(output)) {
      const next = output.shift();
      if (next === undefined) {
        throw new Error(`No fake git output left for ${key}`);
      }
      return next;
    }
    if (output === undefined) {
      throw new Error(`Unexpected git command: ${key}`);
    }
    return output;
  });
}

describe("git repository runtime port", () => {
  it("reads status without mutating the workspace", async () => {
    const runGit = fakeRunGit({
      "branch --show-current": "feature/luna\n",
      "rev-parse HEAD": "base123\n",
      "diff --name-only --cached": "src/a.ts\n",
      "diff --name-only": "src/b.ts\n",
      "ls-files --others --exclude-standard": "src/c.ts\n"
    });
    const git = createGitRepositoryPorts({ runGit });

    await expect(
      git.repository.status({ operation_id: "git.status", workspace })
    ).resolves.toEqual({
      operation_id: "git.status",
      workspace_id: "workspace-1",
      branch: "feature/luna",
      head_sha: "base123",
      dirty: true,
      staged_paths: ["src/a.ts"],
      unstaged_paths: ["src/b.ts"],
      untracked_paths: ["src/c.ts"]
    });
    expect(runGit).not.toHaveBeenCalledWith(
      workspace.path,
      expect.arrayContaining(["commit"])
    );
  });

  it("reads existing commit state from repository head before adoption", async () => {
    const runGit = fakeRunGit({
      "branch --show-current": "feature/luna\n",
      "rev-parse HEAD": "commit123\n",
      "rev-list --parents -n 1 HEAD": "commit123 base123\n",
      "diff --name-only --cached": "",
      "diff --name-only": "",
      "ls-files --others --exclude-standard": "",
      "log -1 --pretty=%B": "Implement thing\n\n",
      "diff-tree --no-commit-id --name-only -r HEAD": "src/a.ts\nsrc/b.ts\n"
    });
    const git = createGitRepositoryPorts({ runGit });

    await expect(
      git.repository.readCommitState({
        operation_id: "git.commit",
        workspace,
        message: "Implement thing",
        paths: ["src/a.ts", "src/b.ts"],
        expected_branch: "feature/luna",
        expected_head_sha: "base123"
      })
    ).resolves.toEqual({
      operation_id: "git.commit",
      workspace_id: "workspace-1",
      branch: "feature/luna",
      head_sha: "base123",
      commit_sha: "commit123",
      message: "Implement thing",
      paths: ["src/a.ts", "src/b.ts"]
    });
  });

  it("records pre-write head and commits selected paths", async () => {
    const runGit = fakeRunGit({
      "branch --show-current": "feature/luna\n",
      "rev-parse HEAD": ["base123\n", "commit456\n"],
      "diff --name-only --cached": "",
      "diff --name-only": "src/a.ts\n",
      "ls-files --others --exclude-standard": "",
      "merge-base --is-ancestor root123 HEAD": "",
      "remote get-url origin": "git@github.com:octo-org/hello-world.git\n",
      "--literal-pathspecs add -A -- src/a.ts": "",
      "commit -m Implement thing": ""
    });
    const git = createGitRepositoryPorts({ runGit });

    await expect(
      git.repository.commit({
        operation_id: "git.commit",
        workspace,
        message: "Implement thing",
        paths: ["src/a.ts"],
        expected_branch: "feature/luna",
        expected_head_sha: "base123",
        expected_base_sha: "root123",
        remote: "origin",
        expected_remote_urls: ["git@github.com:octo-org/hello-world.git"]
      })
    ).resolves.toEqual({
      operation_id: "git.commit",
      workspace_id: "workspace-1",
      branch: "feature/luna",
      head_sha: "base123",
      commit_sha: "commit456",
      message: "Implement thing",
      paths: ["src/a.ts"],
      adopted: false
    });
    expect(runGit).toHaveBeenCalledWith(workspace.path, [
      "--literal-pathspecs",
      "add",
      "-A",
      "--",
      "src/a.ts"
    ]);
    expect(runGit).toHaveBeenCalledWith(workspace.path, [
      "commit",
      "-m",
      "Implement thing"
    ]);
  });

  it("refuses to commit when the workspace moved after the adoption check", async () => {
    const runGit = fakeRunGit({
      "branch --show-current": "feature/luna\n",
      "rev-parse HEAD": "moved789\n",
      "diff --name-only --cached": "",
      "diff --name-only": "src/a.ts\n",
      "ls-files --others --exclude-standard": ""
    });
    const git = createGitRepositoryPorts({ runGit });

    await expect(
      git.repository.commit({
        operation_id: "git.commit",
        workspace,
        message: "Implement thing",
        paths: ["src/a.ts"],
        expected_branch: "feature/luna",
        expected_head_sha: "base123"
      })
    ).rejects.toMatchObject({
      code: "git_conflict"
    });
    expect(runGit).not.toHaveBeenCalledWith(
      workspace.path,
      expect.arrayContaining(["add"])
    );
    expect(runGit).not.toHaveBeenCalledWith(
      workspace.path,
      expect.arrayContaining(["commit"])
    );
  });

  it("refuses to commit when expected base ancestry fails", async () => {
    const baseRunGit = fakeRunGit({
      "branch --show-current": "feature/luna\n",
      "rev-parse HEAD": "base123\n",
      "diff --name-only --cached": "",
      "diff --name-only": "src/a.ts\n",
      "ls-files --others --exclude-standard": ""
    });
    const runGit = vi.fn(async (cwd: string, args: readonly string[]) => {
      if (args.join(" ") === "merge-base --is-ancestor root123 HEAD") {
        const error = new Error("not ancestor") as Error & { exitCode: number };
        error.exitCode = 1;
        throw error;
      }

      return await baseRunGit(cwd, args);
    });
    const git = createGitRepositoryPorts({ runGit });

    await expect(
      git.repository.commit({
        operation_id: "git.commit",
        workspace,
        message: "Implement thing",
        paths: ["src/a.ts"],
        expected_branch: "feature/luna",
        expected_head_sha: "base123",
        expected_base_sha: "root123"
      })
    ).rejects.toMatchObject({
      code: "git_conflict"
    });
    expect(runGit).not.toHaveBeenCalledWith(
      workspace.path,
      expect.arrayContaining(["commit"])
    );
  });

  it("refuses to push when HEAD differs from the expected commit", async () => {
    const runGit = fakeRunGit({
      "rev-parse HEAD": "other456\n"
    });
    const git = createGitRepositoryPorts({ runGit });

    await expect(
      git.repository.pushBranch({
        operation_id: "git.push_branch",
        workspace,
        branch: "feature/luna",
        remote: "origin",
        expected_commit_sha: "commit123"
      })
    ).rejects.toMatchObject({
      code: "git_conflict"
    });
    expect(runGit).not.toHaveBeenCalledWith(workspace.path, [
      "push",
      "origin",
      "feature/luna"
    ]);
  });
});
