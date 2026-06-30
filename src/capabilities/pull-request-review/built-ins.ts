import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import type {
  BuiltInStep,
  BuiltInStepDependencies,
  BuiltInStepRunOptions
} from "../../core/built-ins/types.js";
import { PullRequestReviewResolvedInputSchema } from "./contracts.js";
import type {
  PullRequestReviewBuiltInPorts,
  PullRequestReviewPublishInput,
  PullRequestReviewSkippedResult
} from "./contracts.js";
import {
  effectiveEvent,
  reviewBodyFrom,
  reviewCommentsFrom
} from "./review-policy.js";

export type PullRequestReviewBuiltInPortResolver =
  | PullRequestReviewBuiltInPorts
  | ((options: BuiltInStepRunOptions) => PullRequestReviewBuiltInPorts);

type PullRequestReviewBuiltInDependencies = BuiltInStepDependencies & {
  readonly pullRequestReview?: PullRequestReviewBuiltInPorts;
};

function pullRequestReviewError(
  message: string,
  code = "pull_request_review_input_invalid"
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function pullRequestReviewPortsFromBuiltInOptions({
  dependencies = {}
}: BuiltInStepRunOptions<PullRequestReviewBuiltInDependencies>): PullRequestReviewBuiltInPorts {
  if (dependencies.pullRequestReview === undefined) {
    throw pullRequestReviewError(
      "Pull request review ports are not configured for this runtime.",
      "pull_request_review_port_unavailable"
    );
  }

  return dependencies.pullRequestReview;
}

function resolvePorts(
  resolver: PullRequestReviewBuiltInPortResolver,
  options: BuiltInStepRunOptions
): PullRequestReviewBuiltInPorts {
  return typeof resolver === "function" ? resolver(options) : resolver;
}

function skipped(
  reason: string,
  enabled = true,
  error?: PullRequestReviewSkippedResult["error"]
): PullRequestReviewSkippedResult {
  return {
    operation_id: "pull-request-review.publish",
    enabled,
    skipped: true,
    reason,
    ...(error !== undefined ? { error } : {})
  };
}

function publishFailure(error: unknown): PullRequestReviewSkippedResult {
  const candidate = error instanceof Error ? error : undefined;
  const record = objectRecord(error);

  return skipped("publish_failed", true, {
    ...(typeof record?.code === "string" ? { code: record.code } : {}),
    message: candidate?.message ?? "Pull request review publication failed",
    ...(record !== undefined && "details" in record
      ? { details: record.details }
      : {})
  });
}

function isPublishFailed(error: unknown): boolean {
  return objectRecord(error)?.code === "pull_request_review_publish_failed";
}

function readEnabled(input: Record<string, unknown> | undefined): boolean {
  if (
    input?.operation_id !== undefined &&
    input.operation_id !== "pull-request-review.publish"
  ) {
    throw pullRequestReviewError("Pull request review operation_id is invalid.");
  }
  if (input?.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw pullRequestReviewError("Pull request review enabled must be a boolean.");
  }
  return input?.enabled ?? true;
}

function readEnabledInput(input: Record<string, unknown>) {
  const parsed = PullRequestReviewResolvedInputSchema.safeParse(input);
  if (!parsed.success) {
    throw pullRequestReviewError(
      "Pull request review input did not match the publish schema."
    );
  }

  return parsed.data;
}

function publishInputFrom(
  input: Record<string, unknown> | undefined
): PullRequestReviewPublishInput | PullRequestReviewSkippedResult {
  if (!readEnabled(input)) {
    return skipped("disabled", false);
  }
  if (input === undefined) {
    throw pullRequestReviewError("Pull request review input is required.");
  }

  const enabledInput = readEnabledInput(input);
  const findings = (enabledInput.findings?.findings ?? []).filter(
    (finding) => finding.evidence.length > 0
  );
  const { comments, fallbackComments } = reviewCommentsFrom({
    findings,
    repoContext: enabledInput.repo_context,
    policy: enabledInput.comment_policy
  });
  const effectiveComments = enabledInput.inline_comments ? comments : [];
  const effectiveFallbackComments = enabledInput.inline_comments
    ? fallbackComments
    : [
        ...fallbackComments,
        ...comments.map(({ path, line, body }) => ({ path, line, body }))
      ];

  return {
    operation_id: "pull-request-review.publish",
    enabled: true,
    provider_id: enabledInput.provider_id,
    repository_path: enabledInput.repository_path,
    owner: enabledInput.pull_request.owner,
    repo: enabledInput.pull_request.repo,
    pull_number: enabledInput.pull_request.number,
    event: effectiveEvent(enabledInput.event, findings, enabledInput.acceptance),
    body: reviewBodyFrom({
      body: enabledInput.body,
      acceptance: enabledInput.acceptance,
      findings
    }),
    comments: effectiveComments,
    fallback_comments: effectiveFallbackComments
  };
}

function isSkipped(
  input: PullRequestReviewPublishInput | PullRequestReviewSkippedResult
): input is PullRequestReviewSkippedResult {
  return "skipped" in input && input.skipped;
}

export function createPullRequestReviewPublishBuiltIn(
  ports: PullRequestReviewBuiltInPortResolver
): BuiltInStep<"pull-request-review.publish"> {
  return defineBuiltInStep({
    name: "pull-request-review.publish",
    async run(options) {
      const input = publishInputFrom(options.input);
      if (isSkipped(input)) {
        return input;
      }

      const provider = resolvePorts(ports, options).providers.get(input.provider_id);

      try {
        return await provider.publishReview(input);
      } catch (error) {
        if (!isPublishFailed(error)) {
          throw error;
        }

        return publishFailure(error);
      }
    }
  });
}
