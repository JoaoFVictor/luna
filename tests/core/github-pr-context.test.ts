import { describe, expect, it } from "vitest";
import {
  githubPullRequestContextFrom,
  type GitHubPullRequestContext
} from "../../src/core/providers/github/pull-request-context.js";
import type { NormalizedInvocation } from "../../src/core/invocation/types.js";

const invocation: NormalizedInvocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  repository: {
    provider: "github",
    owner: "octo-org",
    name: "hello-world"
  },
  subject: {
    type: "pull_request",
    id: "42",
    url: "https://github.com/octo-org/hello-world/pull/42",
    title: "Add enterprise adapters"
  },
  references: {
    base_ref: "main",
    base_sha: "abc123",
    head_sha: "def456"
  },
  payload: {
    pull_request: {
      number: 42
    },
    base_repository: {
      owner: "octo-org",
      name: "hello-world",
      full_name: "octo-org/hello-world"
    },
    head_repository: {
      owner: "contributor",
      name: "hello-world",
      full_name: "contributor/hello-world",
      fork: true
    }
  }
};

describe("GitHub PR context parser", () => {
  it("extracts normalized GitHub pull request context", () => {
    const expected: GitHubPullRequestContext = {
      owner: "octo-org",
      repo: "hello-world",
      pull_number: 42,
      base_ref: "main",
      base_repository: {
        owner: "octo-org",
        name: "hello-world",
        full_name: "octo-org/hello-world"
      },
      head_repository: {
        owner: "contributor",
        name: "hello-world",
        full_name: "contributor/hello-world",
        fork: true
      },
      references: {
        base_sha: "abc123",
        head_sha: "def456"
      },
      subject: invocation.subject!
    };

    expect(githubPullRequestContextFrom(invocation)).toEqual(expected);
  });

  it("preserves the generic subject type error code", () => {
    expect(() =>
      githubPullRequestContextFrom({
        ...invocation,
        subject: {
          type: "jira_issue",
          id: "LUNA-123"
        }
      })
    ).toThrow(expect.objectContaining({ code: "invocation_subject_invalid" }));
  });
});
