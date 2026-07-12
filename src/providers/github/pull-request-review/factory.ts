import type {
  PullRequestReviewEvent,
  PullRequestReviewFallbackComment,
  PullRequestReviewProviderFactory,
  PullRequestReviewPublishInput,
  PullRequestReviewPublishedResult
} from "../../../capabilities/pull-request-review/contracts.js";
import {
  githubApiErrorResponse,
  runGh as defaultRunGh,
  type GitHubApiErrorResponse,
  type RunGh
} from "../gh.js";

type PullRequestReviewError = Error & {
  code: "pull_request_review_unknown_publish_outcome";
  details: {
    reason?: string;
    endpoint?: string;
    event?: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
    inline_comments?: number;
    fallback_comments?: number;
    body_bytes?: number;
    cause?: {
      code?: string;
      message?: string;
      exit_code?: number | null;
      stdout?: string;
      stderr?: string;
      timed_out?: boolean;
    };
  };
  cause?: unknown;
};

function unknownPublishOutcomeError(
  message: string,
  details: PullRequestReviewError["details"],
  cause?: unknown
): PullRequestReviewError {
  const error = new Error(
    message,
    cause === undefined ? undefined : { cause }
  ) as PullRequestReviewError;
  error.code = "pull_request_review_unknown_publish_outcome";
  error.details = {
    ...details,
    ...(cause === undefined ? {} : { cause: causeDetails(cause) })
  };
  if (cause !== undefined) {
    error.cause = cause;
  }

  return error;
}

function truncate(value: string, maxLength = 4000): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}... [truncated]`;
}

function causeDetails(
  cause: unknown
): NonNullable<PullRequestReviewError["details"]["cause"]> {
  if (!(cause instanceof Error)) {
    return { message: typeof cause === "string" ? cause : "Unknown error" };
  }

  const coded = cause as {
    code?: unknown;
    details?: {
      exit_code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      timed_out?: unknown;
    };
  };
  const details = coded.details;

  return {
    ...(typeof coded.code === "string" ? { code: coded.code } : {}),
    message: cause.message,
    ...(typeof details?.exit_code === "number" || details?.exit_code === null
      ? { exit_code: details.exit_code }
      : {}),
    ...(typeof details?.stdout === "string" && details.stdout.trim() !== ""
      ? { stdout: truncate(details.stdout.trim()) }
      : {}),
    ...(typeof details?.stderr === "string"
      ? { stderr: truncate(details.stderr.trim()) }
      : {}),
    ...(typeof details?.timed_out === "boolean" ? { timed_out: details.timed_out } : {})
  };
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

function reviewErrorDetails(
  input: PullRequestReviewPublishInput,
  endpoint: string,
  event: ReturnType<typeof ghEvent>
): Omit<PullRequestReviewError["details"], "cause"> {
  return {
    endpoint,
    event,
    inline_comments: input.comments.length,
    fallback_comments: input.fallback_comments.length,
    body_bytes: Buffer.byteLength(reviewBody(input), "utf8")
  };
}

function reviewPayload(
  input: PullRequestReviewPublishInput
): {
  event: ReturnType<typeof ghEvent>;
  body: string;
  comments?: PullRequestReviewPublishInput["comments"];
} {
  return {
    event: ghEvent(input.event),
    body: reviewBody(input),
    ...(input.comments.length > 0 ? { comments: input.comments } : {})
  };
}

function isOwnPullRequestRequestChangesRejection(cause: unknown): boolean {
  const response = githubApiErrorResponse(cause);
  return response?.status === 422 && response.errors.some(
    (error) => error.toLowerCase().includes(
      "can not request changes on your own pull request"
    )
  );
}

function rejectedPublishError(
  response: GitHubApiErrorResponse,
  details: Omit<PullRequestReviewError["details"], "cause">,
  cause: unknown
): Error & {
  code: "pull_request_review_publish_failed";
  details: PullRequestReviewError["details"] & {
    provider_status?: number;
    provider_message?: string;
    provider_errors: readonly string[];
    documentation_url?: string;
  };
} {
  const providerReason = response.errors[0] ?? response.message ?? "request rejected";
  const error = new Error(
    `GitHub pull request review was rejected: ${providerReason}`,
    { cause }
  ) as Error & {
    code: "pull_request_review_publish_failed";
    details: PullRequestReviewError["details"] & {
      provider_status?: number;
      provider_message?: string;
      provider_errors: readonly string[];
      documentation_url?: string;
    };
  };
  error.code = "pull_request_review_publish_failed";
  error.details = {
    ...details,
    reason: "provider_rejected",
    ...(response.status === undefined ? {} : { provider_status: response.status }),
    ...(response.message === undefined ? {} : { provider_message: response.message }),
    provider_errors: response.errors,
    ...(response.documentation_url === undefined
      ? {}
      : { documentation_url: response.documentation_url }),
    cause: causeDetails(cause)
  };
  return error;
}

function publishDispatchError(
  input: PullRequestReviewPublishInput,
  endpoint: string,
  event: ReturnType<typeof ghEvent>,
  cause: unknown
): Error {
  const details = reviewErrorDetails(input, endpoint, event);
  const response = githubApiErrorResponse(cause);
  if (response !== undefined) {
    return rejectedPublishError(response, details, cause);
  }

  return unknownPublishOutcomeError(
    "GitHub pull request review acceptance is unknown",
    { ...details, reason: "transport_result_unknown" },
    cause
  );
}

function publishReviewRequest(
  input: PullRequestReviewPublishInput,
  endpoint: string,
  runGh: RunGh
): Promise<string> {
  return runGh(
    input.repository_path,
    ["api", "-X", "POST", endpoint, "--input", "-"],
    {
      input: JSON.stringify(reviewPayload(input)),
      timeoutMs: 60_000
    }
  );
}

function parseReviewJson(
  output: string,
  details: Omit<PullRequestReviewError["details"], "cause">
): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw unknownPublishOutcomeError(
      "GitHub pull request review response was not valid JSON",
      { ...details, reason: "response_json_invalid" }
    );
  }
}

function parseReviewResponse(
  response: unknown,
  input: PullRequestReviewPublishInput,
  details: Omit<PullRequestReviewError["details"], "cause">
): PullRequestReviewPublishedResult {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw unknownPublishOutcomeError(
      "GitHub pull request review response was not an object",
      { ...details, reason: "response_not_object" }
    );
  }

  const candidate = response as { id?: unknown; html_url?: unknown };
  if (
    (typeof candidate.id !== "number" && typeof candidate.id !== "string") ||
    typeof candidate.html_url !== "string" ||
    candidate.html_url.trim() === ""
  ) {
    throw unknownPublishOutcomeError(
      "GitHub pull request review response did not include id and html_url",
      { ...details, reason: "response_missing_review_identity" }
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
  runGh = defaultRunGh
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
          let effectiveInput = input;
          let event = ghEvent(effectiveInput.event);
          let details = reviewErrorDetails(effectiveInput, endpoint, event);
          let output: string;
          try {
            output = await publishReviewRequest(effectiveInput, endpoint, runGh);
          } catch (cause) {
            if (
              event !== "REQUEST_CHANGES" ||
              !isOwnPullRequestRequestChangesRejection(cause)
            ) {
              throw publishDispatchError(effectiveInput, endpoint, event, cause);
            }

            effectiveInput = { ...input, event: "comment" };
            event = ghEvent(effectiveInput.event);
            details = reviewErrorDetails(effectiveInput, endpoint, event);
            try {
              output = await publishReviewRequest(effectiveInput, endpoint, runGh);
            } catch (retryCause) {
              throw publishDispatchError(
                effectiveInput,
                endpoint,
                event,
                retryCause
              );
            }
          }

          const response = parseReviewJson(output, details);
          return parseReviewResponse(response, effectiveInput, details);
        }
      };
    }
  };
}
