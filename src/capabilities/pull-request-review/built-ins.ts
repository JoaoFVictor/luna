import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import type {
  BuiltInStep,
  BuiltInStepDependencies,
  BuiltInStepRunOptions
} from "../../core/built-ins/types.js";
import {
  type Finding
} from "../../core/findings/types.js";
import {
  type ChangedFile,
  type RepoContext
} from "../git/diff/types.js";
import { patchHasRightSideLine } from "./diff-lines.js";
import { PullRequestReviewResolvedInputSchema } from "./contracts.js";
import type {
  PullRequestReviewAcceptance,
  PullRequestReviewConfiguredEvent,
  PullRequestReviewBuiltInPorts,
  PullRequestReviewComment,
  PullRequestReviewEvent,
  PullRequestReviewFallbackComment,
  PullRequestReviewPublishInput,
  PullRequestReviewSkippedResult
} from "./contracts.js";

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
  const candidate = error instanceof Error
    ? error as Error & { code?: unknown; details?: unknown }
    : undefined;

  return skipped("publish_failed", true, {
    ...(typeof candidate?.code === "string" ? { code: candidate.code } : {}),
    message: candidate?.message ?? "Pull request review publication failed",
    ...(candidate !== undefined && "details" in candidate
      ? { details: candidate.details }
      : {})
  });
}

function isPublishFailed(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "pull_request_review_publish_failed";
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

function commentBody(finding: Finding): string {
  return [
    `**${finding.severity}: ${finding.title}**`,
    "",
    finding.description,
    "",
    `Recommendation: ${finding.recommendation}`
  ].join("\n");
}

function reviewResultLabel({
  acceptance,
  findings
}: {
  readonly acceptance?: PullRequestReviewAcceptance;
  readonly findings: readonly Finding[];
}): string {
  if (
    findings.length > 0 ||
    acceptance?.recommended_action === "request_changes"
  ) {
    return "changes requested";
  }

  if (
    acceptance?.status === "needs_human_review" ||
    acceptance?.recommended_action === "human_review"
  ) {
    return "needs human review";
  }

  if (
    acceptance?.status === "accepted" ||
    acceptance?.recommended_action === "approve"
  ) {
    return "approved";
  }

  if (acceptance?.status === "rejected") {
    return "not accepted";
  }

  return "comment";
}

function reviewBodyFrom({
  body,
  acceptance,
  findings
}: {
  readonly body: string;
  readonly acceptance?: PullRequestReviewAcceptance;
  readonly findings: readonly Finding[];
}): string {
  if (acceptance === undefined) {
    return body;
  }

  const result = reviewResultLabel({ acceptance, findings });
  const lines = [`Review result: ${result}`, "", acceptance.summary];

  if (acceptance.blocking_reasons.length > 0) {
    lines.push(
      "",
      "Blocking reasons:",
      ...acceptance.blocking_reasons.map((reason) => `- ${reason}`)
    );
  }

  return lines.join("\n");
}

function lineIsRightSidePatchLine(file: ChangedFile | undefined, line: number): boolean {
  return patchHasRightSideLine(file?.patch, line);
}

function reviewCommentsFrom({
  findings,
  repoContext
}: {
  readonly findings: readonly Finding[];
  readonly repoContext?: RepoContext;
}): {
  comments: PullRequestReviewComment[];
  fallbackComments: PullRequestReviewFallbackComment[];
} {
  const filesByPath = new Map(
    (repoContext?.files ?? []).map((file) => [file.path, file])
  );
  const comments: PullRequestReviewComment[] = [];
  const fallbackComments: PullRequestReviewFallbackComment[] = [];

  for (const finding of findings) {
    const body = commentBody(finding);
    for (const evidence of finding.evidence) {
      const line = evidence.line_start;
      if (lineIsRightSidePatchLine(filesByPath.get(evidence.path), line)) {
        comments.push({
          path: evidence.path,
          line,
          side: "RIGHT",
          body
        });
      } else {
        fallbackComments.push({
          path: evidence.path,
          line,
          body
        });
      }
    }
  }

  return { comments, fallbackComments };
}

function effectiveEvent(
  requestedEvent: PullRequestReviewConfiguredEvent,
  findings: readonly Finding[]
): PullRequestReviewEvent {
  const hasFindings = findings.length > 0;

  if (requestedEvent === "auto") {
    return hasFindings ? "request_changes" : "comment";
  }

  if (requestedEvent === "request_changes" && !hasFindings) {
    return "comment";
  }

  if (requestedEvent === "approve" && hasFindings) {
    return "comment";
  }

  return requestedEvent;
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
  const findings = enabledInput.findings?.findings ?? [];
  const { comments, fallbackComments } = reviewCommentsFrom({
    findings,
    repoContext: enabledInput.repo_context
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
    event: effectiveEvent(enabledInput.event, findings),
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
