import type {
  PullRequestReviewEvent,
  PullRequestReviewFallbackComment,
  PullRequestReviewProviderFactory,
  PullRequestReviewPublishInput,
  PullRequestReviewPublishedResult
} from "../../../capabilities/pull-request-review/contracts.js";
import { runGhJson, type RunGh } from "../gh.js";

type PullRequestReviewError = Error & {
  code: "pull_request_review_publish_failed";
  cause?: unknown;
};

function pullRequestReviewError(
  message: string,
  cause: unknown
): PullRequestReviewError {
  const error = new Error(message, { cause }) as PullRequestReviewError;
  error.code = "pull_request_review_publish_failed";
  error.cause = cause;

  return error;
}

function ghEvent(event: PullRequestReviewEvent): "COMMENT" | "REQUEST_CHANGES" | "APPROVE" {
  switch (event) {
    case "comment":
      return "COMMENT";
    case "request_changes":
      return "REQUEST_CHANGES";
    case "approve":
      return "APPROVE";
  }
}

function fallbackMarkdown(
  fallbackComments: readonly PullRequestReviewFallbackComment[]
): string {
  if (fallbackComments.length === 0) {
    return "";
  }

  return [
    "",
    "## Findings not placed inline",
    "",
    ...fallbackComments.flatMap((comment) => [
      `### ${comment.path}:${comment.line}`,
      "",
      comment.body,
      ""
    ])
  ].join("\n");
}

function reviewBody(input: PullRequestReviewPublishInput): string {
  return `${input.body}${fallbackMarkdown(input.fallback_comments)}`;
}

function parseReviewResponse(
  response: unknown,
  input: PullRequestReviewPublishInput
): PullRequestReviewPublishedResult {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw pullRequestReviewError(
      "GitHub pull request review response was not an object",
      { response }
    );
  }

  const candidate = response as { id?: unknown; html_url?: unknown };
  if (
    (typeof candidate.id !== "number" && typeof candidate.id !== "string") ||
    typeof candidate.html_url !== "string" ||
    candidate.html_url.trim() === ""
  ) {
    throw pullRequestReviewError(
      "GitHub pull request review response did not include id and html_url",
      { response }
    );
  }

  return {
    operation_id: "pull-request-review.publish",
    enabled: true,
    skipped: false,
    provider: "github",
    provider_id: "github",
    external_id: String(candidate.id),
    url: candidate.html_url,
    event: input.event,
    inline_comments: input.comments.length,
    fallback_comments: input.fallback_comments.length
  };
}

export function createGitHubPullRequestReviewProviderFactory({
  runGh
}: {
  readonly runGh?: RunGh;
} = {}): PullRequestReviewProviderFactory {
  return {
    provider_id: "github",
    createProvider() {
      return {
        provider_id: "github",
        async publishReview(input) {
          const endpoint =
            `repos/${input.owner}/${input.repo}/pulls/${input.pull_number}/reviews`;
          let response: unknown;
          try {
            response = await runGhJson(
              input.repository_path,
              ["api", "-X", "POST", endpoint, "--input", "-"],
              {
                event: ghEvent(input.event),
                body: reviewBody(input),
                comments: input.comments
              },
              runGh
            );
          } catch (cause) {
            throw pullRequestReviewError(
              "Failed to publish GitHub pull request review",
              cause
            );
          }

          return parseReviewResponse(response, input);
        }
      };
    }
  };
}
