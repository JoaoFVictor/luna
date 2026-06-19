import { describe, expect, it, vi } from "vitest";
import { githubPrUrlAdapter } from "../../src/adapters/github-pr-url/index.js";
import type { AdapterContext } from "../../src/adapters/types.js";

const githubPullResponse = {
  number: 123,
  base: {
    ref: "main",
    sha: "base-sha",
    repo: {
      name: "luna",
      full_name: "withastro/luna",
      owner: {
        login: "withastro"
      }
    }
  },
  head: {
    sha: "head-sha",
    repo: {
      name: "luna",
      full_name: "contributor/luna",
      fork: true,
      owner: {
        login: "contributor"
      }
    }
  }
};

function context(
  executeJson: AdapterContext["executeJson"] = vi.fn(
    async () => githubPullResponse
  )
): AdapterContext {
  return {
    projectRoot: "/workspace/project",
    configRoot: "/workspace/config",
    env: {},
    fetch,
    executeJson
  };
}

describe("github-pr-url adapter", () => {
  it("loads PR metadata and returns a normalized invocation", async () => {
    const executeJson = vi.fn(async () => githubPullResponse);

    await expect(
      githubPrUrlAdapter.load(
        { kind: "cli", value: "https://github.com/withastro/luna/pull/123" },
        context(executeJson)
      )
    ).resolves.toEqual({
      version: "2026-06",
      source: "github",
      event: "pull_request",
      action: "selected",
      repository: {
        provider: "github",
        owner: "withastro",
        name: "luna"
      },
      subject: {
        type: "pull_request",
        id: "123",
        url: "https://github.com/withastro/luna/pull/123",
        title: "withastro/luna#123"
      },
      references: {
        base_ref: "main",
        base_sha: "base-sha",
        head_sha: "head-sha"
      },
      payload: {
        pull_request: {
          number: 123
        },
        base_repository: {
          owner: "withastro",
          name: "luna",
          full_name: "withastro/luna"
        },
        head_repository: {
          owner: "contributor",
          name: "luna",
          full_name: "contributor/luna",
          fork: true
        }
      }
    });

    expect(executeJson).toHaveBeenCalledWith("gh", [
      "api",
      "repos/withastro/luna/pulls/123"
    ]);
  });

  it("rejects URLs that are not GitHub pull request URLs", async () => {
    await expect(
      githubPrUrlAdapter.load(
        { kind: "cli", value: "https://github.com/withastro/luna/issues/123" },
        context()
      )
    ).rejects.toThrow(expect.objectContaining({ code: "invalid_pr_url" }));
  });

  it("throws when GitHub returns a PR without an available head repository", async () => {
    const executeJson = vi.fn(async () => ({
      ...githubPullResponse,
      head: {
        ...githubPullResponse.head,
        repo: null
      }
    }));

    await expect(
      githubPrUrlAdapter.load(
        { kind: "cli", value: "https://github.com/withastro/luna/pull/123" },
        context(executeJson)
      )
    ).rejects.toThrow(
      expect.objectContaining({ code: "github_pr_head_repo_missing" })
    );
  });
});
