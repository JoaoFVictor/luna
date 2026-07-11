import { describe, expect, it, vi } from "vitest";
import type {
  PullRequestReviewPublishInput
} from "../../../src/capabilities/pull-request-review/contracts.js";
import {
  createGitHubPullRequestReviewProviderFactory
} from "../../../src/providers/github/pull-request-review/factory.js";
import type { RunGh } from "../../../src/providers/github/gh.js";

function reviewResponse(id: number): string {
  return JSON.stringify({
    id,
    html_url:
      `https://github.com/octo-org/hello-world/pull/42#pullrequestreview-${id}`
  });
}

function reviewInput(
  overrides: Partial<PullRequestReviewPublishInput> = {}
): PullRequestReviewPublishInput {
  return {
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
    fallback_comments: [],
    ...overrides
  };
}

function providerFor(runGh: RunGh) {
  return createGitHubPullRequestReviewProviderFactory({
    runGh
  }).createProvider();
}

describe("GitHub pull request review provider", () => {
  it("posts a formal GitHub review with inline comments through gh api", async () => {
    const runGh = vi.fn(async () => reviewResponse(123));
    const provider = providerFor(runGh);

    await expect(
      provider.publishReview(reviewInput({
        event: "request_changes",
        comments: [
          {
            path: "src/app.ts",
            line: 43,
            side: "RIGHT",
            body: "Fix the nullable value."
          }
        ],
        fallback_comments: []
      }))
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
    const runGh = vi.fn(async () => reviewResponse(124));
    const provider = providerFor(runGh);

    await provider.publishReview(reviewInput({
      fallback_comments: [
        {
          path: "src/app.ts",
          line: 99,
          body: "This finding could not be placed inline."
        }
      ]
    }));

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

  it("omits the comments payload field when there are no inline comments", async () => {
    const runGh = vi.fn(async () => reviewResponse(125));
    const provider = providerFor(runGh);

    await provider.publishReview(reviewInput({ body: "No validated findings." }));

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
          event: "COMMENT",
          body: "No validated findings."
        }),
        timeoutMs: 60_000
      })
    );
  });

  it("treats a post-dispatch CLI failure as unknown while preserving diagnostics", async () => {
    const cause = new Error("GitHub CLI command failed") as Error & {
      code: "github_cli_failed";
      details: {
        exit_code: number;
        stderr: string;
        timed_out: boolean;
      };
    };
    cause.code = "github_cli_failed";
    cause.details = {
      exit_code: 1,
      stderr: "GraphQL: Cannot request changes on your own pull request\n",
      timed_out: false
    };
    const runGh = vi.fn(async () => {
      throw cause;
    });
    const provider = providerFor(runGh);

    await expect(
      provider.publishReview(reviewInput({ event: "request_changes" }))
    ).rejects.toMatchObject({
      code: "pull_request_review_unknown_publish_outcome",
      details: {
        endpoint: "repos/octo-org/hello-world/pulls/42/reviews",
        event: "REQUEST_CHANGES",
        inline_comments: 0,
        fallback_comments: 0,
        body_bytes: 18,
        reason: "transport_result_unknown",
        cause: {
          code: "github_cli_failed",
          message: "GitHub CLI command failed",
          exit_code: 1,
          stderr: "GraphQL: Cannot request changes on your own pull request",
          timed_out: false
        }
      }
    });
  });

  it("reports unknown publish outcome when GitHub returns an unexpected review response", async () => {
    const runGh = vi.fn(async () => JSON.stringify({ ok: true }));
    const provider = providerFor(runGh);

    await expect(
      provider.publishReview(reviewInput())
    ).rejects.toMatchObject({
      code: "pull_request_review_unknown_publish_outcome",
      details: {
        endpoint: "repos/octo-org/hello-world/pulls/42/reviews",
        event: "COMMENT",
        inline_comments: 0,
        fallback_comments: 0,
        body_bytes: 18,
        reason: "response_missing_review_identity"
      }
    });
  });

  it("reports unknown publish outcome when GitHub returns invalid JSON after the review request", async () => {
    const runGh = vi.fn(async () => "not-json");
    const provider = providerFor(runGh);

    await expect(
      provider.publishReview(reviewInput())
    ).rejects.toMatchObject({
      code: "pull_request_review_unknown_publish_outcome",
      details: {
        endpoint: "repos/octo-org/hello-world/pulls/42/reviews",
        event: "COMMENT",
        inline_comments: 0,
        fallback_comments: 0,
        body_bytes: 18,
        reason: "response_json_invalid"
      }
    });
  });
});
