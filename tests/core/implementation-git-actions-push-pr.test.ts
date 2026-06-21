import { describe, expect, it } from "vitest";
import { pushBranch } from "../../src/core/implementation-git-actions.js";
import { openGitHubChangeRequest } from "../../src/core/providers/github/change-request-actions.js";
import type {
  CommitChangesArtifact,
  ChangeRequestArtifact,
  PushBranchArtifact
} from "../../src/core/types.js";

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
  "git@github.com:swinggo-dev/swg-front-nuxt.git",
  "https://github.com/swinggo-dev/swg-front-nuxt.git"
];
const commitMessage = "ABC-123: Fix checkout validation";

function createRunGit({
  currentBranch = branch,
  remoteUrl = "git@github.com:swinggo-dev/swg-front-nuxt.git"
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

describe("openGitHubChangeRequest", () => {
  const pushed: PushBranchArtifact = {
    enabled: true,
    skipped: false,
    remote,
    branch
  };

  function prInput(
    overrides: Partial<Parameters<typeof openGitHubChangeRequest>[0]> = {}
  ) {
    const calls: GhCall[] = [];

    return {
      input: {
        enabled: true,
        cwd,
        push: pushed,
        branch,
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

    await expect(openGitHubChangeRequest(input)).resolves.toEqual({
      enabled: false,
      skipped: true,
      reason: "disabled"
    });
  });

  it("skips when the branch was not pushed", async () => {
    const { input } = prInput({ push: { enabled: true, skipped: true } });

    await expect(openGitHubChangeRequest(input)).resolves.toEqual({
      enabled: true,
      skipped: true,
      reason: "no_push"
    });
  });

  it("skips when the base ref is missing", async () => {
    const { input } = prInput({ baseRef: "" });

    await expect(openGitHubChangeRequest(input)).resolves.toEqual({
      enabled: true,
      skipped: true,
      reason: "base_ref_missing"
    });
  });

  it("skips when the pushed branch differs from the registered branch", async () => {
    const { input, calls } = prInput({
      push: { ...pushed, branch: "feature/other" }
    });

    await expect(openGitHubChangeRequest(input)).resolves.toEqual({
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

    await expect(openGitHubChangeRequest(input)).resolves.toEqual({
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

    await expect(openGitHubChangeRequest(input)).rejects.toMatchObject({
      code: "change_request_create_failed",
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

    await expect(openGitHubChangeRequest(input)).resolves.toEqual({
      enabled: true,
      skipped: false,
      provider: "github",
      url: "https://github.com/swinggo-dev/swg-front-nuxt/pull/42"
    } satisfies ChangeRequestArtifact);
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
