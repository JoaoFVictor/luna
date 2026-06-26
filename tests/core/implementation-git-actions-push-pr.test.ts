import { describe, expect, it } from "vitest";
import { pushBranch } from "../../src/core/write-mode/git-gates.js";
import { createGitHubChangeRequestProviderFactory } from "../../src/providers/github/change-request/factory.js";
import type { CommitChangesArtifact } from "../../src/core/write-mode/types.js";

type GitCall = {
  cwd: string;
  args: readonly string[];
};

type GhCall = {
  cwd: string;
  args: readonly string[];
};

const cwd = "/repo/worktree";
const branch = "feature/abc-123-fix-checkout-validation";
const remote = "origin";
const expectedRemoteUrls = [
  "git@github.com:octo-org/hello-world.git",
  "https://github.com/octo-org/hello-world.git"
];
const commitMessage = "ABC-123: Fix checkout validation";

function createRunGit({
  currentBranch = branch,
  remoteUrl = "git@github.com:octo-org/hello-world.git"
}: {
  currentBranch?: string;
  remoteUrl?: string;
} = {}): {
  calls: GitCall[];
  runGit: (cwd: string, args: readonly string[]) => Promise<string>;
} {
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

      return "";
    }
  };
}

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

describe("createGitHubChangeRequestProviderFactory", () => {
  it("adopts an existing GitHub PR from gh pr list", async () => {
    const calls: GhCall[] = [];
    const provider = createGitHubChangeRequestProviderFactory({
      runGh: async (callCwd, args) => {
        calls.push({ cwd: callCwd, args });
        return JSON.stringify([
          {
            number: 42,
            url: "https://github.com/octo-org/hello-world/pull/42",
            title: commitMessage,
            headRefName: branch,
            baseRefName: "main"
          }
        ]);
      }
    }).createProvider();

    await expect(
      provider.readChangeRequest({
        operation_id: "change-request.create",
        enabled: true,
        provider_id: "github",
        repository_path: cwd,
        title: commitMessage,
        source_branch: branch,
        target_branch: "main"
      })
    ).resolves.toEqual({
      operation_id: "change-request.create",
      provider_id: "github",
      external_id: "42",
      url: "https://github.com/octo-org/hello-world/pull/42",
      title: commitMessage,
      source_branch: branch,
      target_branch: "main"
    });
    expect(calls).toEqual([
      {
        cwd,
        args: [
          "pr",
          "list",
          "--head",
          branch,
          "--json",
          "number,url,title,headRefName,baseRefName",
          "--limit",
          "1",
          "--base",
          "main"
        ]
      }
    ]);
  });

  it("normalizes GitHub PR lookup failures", async () => {
    const cause = new Error("invalid json");
    const provider = createGitHubChangeRequestProviderFactory({
      runGh: async () => {
        throw cause;
      }
    }).createProvider();

    await expect(
      provider.readChangeRequest({
        operation_id: "change-request.create",
        enabled: true,
        provider_id: "github",
        repository_path: cwd,
        title: commitMessage,
        source_branch: branch,
        target_branch: "main"
      })
    ).rejects.toMatchObject({
      code: "change_request_create_failed",
      cause
    });
  });

  it("creates a draft GitHub PR through the provider port", async () => {
    const calls: GhCall[] = [];
    const provider = createGitHubChangeRequestProviderFactory({
      runGh: async (callCwd, args) => {
        calls.push({ cwd: callCwd, args });
        return "https://github.com/octo-org/hello-world/pull/42\n";
      }
    }).createProvider();

    await expect(
      provider.createChangeRequest({
        operation_id: "change-request.create",
        enabled: true,
        provider_id: "github",
        repository_path: cwd,
        title: commitMessage,
        description: "Implements ABC-123.",
        source_branch: branch,
        target_branch: "main",
        draft: true
      })
    ).resolves.toEqual({
      operation_id: "change-request.create",
      enabled: true,
      skipped: false,
      provider: "github",
      provider_id: "github",
      external_id: "42",
      url: "https://github.com/octo-org/hello-world/pull/42",
      title: commitMessage,
      source_branch: branch,
      target_branch: "main",
      adopted: false
    });
    expect(calls).toEqual([
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

  it("normalizes GitHub PR creation failures", async () => {
    const cause = new Error("gh pr create failed");
    const provider = createGitHubChangeRequestProviderFactory({
      runGh: async () => {
        throw cause;
      }
    }).createProvider();

    await expect(
      provider.createChangeRequest({
        operation_id: "change-request.create",
        enabled: true,
        provider_id: "github",
        repository_path: cwd,
        title: commitMessage,
        source_branch: branch,
        target_branch: "main"
      })
    ).rejects.toMatchObject({
      code: "change_request_create_failed",
      cause
    });
  });

  it("rejects GitHub PR creation without a returned URL", async () => {
    const provider = createGitHubChangeRequestProviderFactory({
      runGh: async () => "\n"
    }).createProvider();

    await expect(
      provider.createChangeRequest({
        operation_id: "change-request.create",
        enabled: true,
        provider_id: "github",
        repository_path: cwd,
        title: commitMessage,
        source_branch: branch,
        target_branch: "main"
      })
    ).rejects.toMatchObject({
      code: "change_request_create_failed"
    });
  });

  it("rejects GitHub PR creation with an unparseable URL", async () => {
    const provider = createGitHubChangeRequestProviderFactory({
      runGh: async () => "https://github.com/octo-org/hello-world/issues/42\n"
    }).createProvider();

    await expect(
      provider.createChangeRequest({
        operation_id: "change-request.create",
        enabled: true,
        provider_id: "github",
        repository_path: cwd,
        title: commitMessage,
        source_branch: branch,
        target_branch: "main"
      })
    ).rejects.toMatchObject({
      code: "change_request_create_failed"
    });
  });

});
