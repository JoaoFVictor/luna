import { describe, expect, it, vi } from "vitest";
import {
  createGitHubPullRequestReviewProviderFactory
} from "../../../src/providers/github/pull-request-review/factory.js";

describe("GitHub pull request review provider", () => {
  it("posts a formal GitHub review with inline comments through gh api", async () => {
    const runGh = vi.fn(async () =>
      JSON.stringify({
        id: 123,
        html_url: "https://github.com/octo-org/hello-world/pull/42#pullrequestreview-123"
      })
    );
    const provider = createGitHubPullRequestReviewProviderFactory({
      runGh
    }).createProvider();

    await expect(
      provider.publishReview({
        operation_id: "pull-request-review.publish",
        enabled: true,
        provider_id: "github",
        repository_path: "/repo/workspace",
        owner: "octo-org",
        repo: "hello-world",
        pull_number: 42,
        event: "request_changes",
        body: "Luna found issues.",
        comments: [
          {
            path: "src/app.ts",
            line: 43,
            side: "RIGHT",
            body: "Fix the nullable value."
          }
        ],
        fallback_comments: []
      })
    ).resolves.toEqual({
      operation_id: "pull-request-review.publish",
      enabled: true,
      skipped: false,
      provider: "github",
      provider_id: "github",
      external_id: "123",
      url: "https://github.com/octo-org/hello-world/pull/42#pullrequestreview-123",
      event: "request_changes",
      inline_comments: 1,
      fallback_comments: 0
    });

    expect(runGh).toHaveBeenCalledWith(
      "/repo/workspace",
      [
        "api",
        "-X",
        "POST",
        "repos/octo-org/hello-world/pulls/42/reviews",
        "--input",
        "-"
      ],
      expect.objectContaining({
        input: JSON.stringify({
          event: "REQUEST_CHANGES",
          body: "Luna found issues.",
          comments: [
            {
              path: "src/app.ts",
              line: 43,
              side: "RIGHT",
              body: "Fix the nullable value."
            }
          ]
        }),
        timeoutMs: 60_000
      })
    );
  });

  it("appends fallback comments to the review body when inline comments are unavailable", async () => {
    const runGh = vi.fn(async () =>
      JSON.stringify({
        id: 124,
        html_url: "https://github.com/octo-org/hello-world/pull/42#pullrequestreview-124"
      })
    );
    const provider = createGitHubPullRequestReviewProviderFactory({
      runGh
    }).createProvider();

    await provider.publishReview({
      operation_id: "pull-request-review.publish",
      enabled: true,
      provider_id: "github",
      repository_path: "/repo/workspace",
      owner: "octo-org",
      repo: "hello-world",
      pull_number: 42,
      event: "comment",
      body: "Luna found issues.",
      comments: [],
      fallback_comments: [
        {
          path: "src/app.ts",
          line: 99,
          body: "This finding could not be placed inline."
        }
      ]
    });

    expect(runGh).toHaveBeenCalledWith(
      "/repo/workspace",
      [
        "api",
        "-X",
        "POST",
        "repos/octo-org/hello-world/pulls/42/reviews",
        "--input",
        "-"
      ],
      expect.objectContaining({
        input: expect.stringContaining("src/app.ts:99"),
        timeoutMs: 60_000
      })
    );
  });
});
