import { describe, expect, it, vi } from "vitest";
import {
  fetchGitHubPullRequestInvocation,
  parseGitHubPullRequestUrl
} from "../../src/core/github-pr-adapter.js";

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

describe("GitHub PR input adapter", () => {
  it("parses a GitHub pull request URL into repository coordinates", () => {
    expect(
      parseGitHubPullRequestUrl("https://github.com/withastro/luna/pull/123")
    ).toEqual({
      owner: "withastro",
      repo: "luna",
      pull_number: 123
    });
  });

  it("rejects URLs that are not GitHub pull request URLs", () => {
    expect(() =>
      parseGitHubPullRequestUrl("https://github.com/withastro/luna/issues/123")
    ).toThrow(expect.objectContaining({ code: "invalid_pr_url" }));
  });

  it("loads PR metadata through gh api and returns a validated invocation", async () => {
    const executeJson = vi.fn(async () => githubPullResponse);

    await expect(
      fetchGitHubPullRequestInvocation("https://github.com/withastro/luna/pull/123", {
        executeJson
      })
    ).resolves.toEqual({
      target: "github_pr",
      owner: "withastro",
      repo: "luna",
      pull_number: 123,
      base_ref: "main",
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
      },
      references: {
        base_sha: "base-sha",
        head_sha: "head-sha"
      }
    });

    expect(executeJson).toHaveBeenCalledWith("gh", [
      "api",
      "repos/withastro/luna/pulls/123"
    ]);
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
      fetchGitHubPullRequestInvocation("https://github.com/withastro/luna/pull/123", {
        executeJson
      })
    ).rejects.toThrow(expect.objectContaining({ code: "github_pr_head_repo_missing" }));
  });
});
