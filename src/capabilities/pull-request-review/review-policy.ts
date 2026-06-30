import type { Finding } from "../../core/findings/types.js";
import type { ChangedFile, RepoContext } from "../git/diff/types.js";
import type {
  PullRequestReviewAcceptance,
  PullRequestReviewComment,
  PullRequestReviewCommentPolicy,
  PullRequestReviewConfiguredEvent,
  PullRequestReviewEvent,
  PullRequestReviewFallbackComment
} from "./contracts.js";
import { patchHasRightSideLine } from "../../core/repository/diff-hunks.js";

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

export function reviewBodyFrom({
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

function commentLocationKey(comment: {
  readonly path: string;
  readonly line: number;
}): string {
  return [comment.path, comment.line].join("\0");
}

function commentContentKey(comment: {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}): string {
  return [comment.path, comment.line, comment.body].join("\0");
}

function splitInlineCommentsByLocation<T extends {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}>(comments: readonly T[]): {
  inlineCandidates: T[];
  duplicateLocationComments: PullRequestReviewFallbackComment[];
} {
  const byKey = new Map<string, T>();
  const duplicateLocationComments: PullRequestReviewFallbackComment[] = [];
  for (const comment of comments) {
    const key = commentLocationKey(comment);
    if (!byKey.has(key)) {
      byKey.set(key, comment);
      continue;
    }

    duplicateLocationComments.push({
      path: comment.path,
      line: comment.line,
      body: comment.body
    });
  }

  return {
    inlineCandidates: [...byKey.values()],
    duplicateLocationComments
  };
}

function uniqueByCommentContent<T extends {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}>(comments: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const comment of comments) {
    const key = commentContentKey(comment);
    if (!byKey.has(key)) {
      byKey.set(key, comment);
    }
  }

  return [...byKey.values()];
}

export function reviewCommentsFrom({
  findings,
  repoContext,
  policy
}: {
  readonly findings: readonly Finding[];
  readonly repoContext?: RepoContext;
  readonly policy: PullRequestReviewCommentPolicy;
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
    const evidenceRefs = policy.inline_evidence === "primary"
      ? finding.evidence.slice(0, 1)
      : finding.evidence;
    const fallbackEvidenceRefs = policy.inline_evidence === "primary"
      ? finding.evidence.slice(1)
      : [];

    for (const evidence of evidenceRefs) {
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

    for (const evidence of fallbackEvidenceRefs) {
      fallbackComments.push({
        path: evidence.path,
        line: evidence.line_start,
        body
      });
    }
  }

  const {
    inlineCandidates,
    duplicateLocationComments
  } = splitInlineCommentsByLocation(comments);
  const inlineComments = inlineCandidates.slice(0, policy.max_inline_comments);
  const overflowComments = inlineCandidates
    .slice(policy.max_inline_comments)
    .map(({ path, line, body }) => ({ path, line, body }));
  const inlineContentKeys = new Set(inlineComments.map(commentContentKey));

  return {
    comments: inlineComments,
    fallbackComments: uniqueByCommentContent([
      ...fallbackComments,
      ...duplicateLocationComments,
      ...overflowComments
    ]).filter((comment) => !inlineContentKeys.has(commentContentKey(comment)))
  };
}

export function effectiveEvent(
  requestedEvent: PullRequestReviewConfiguredEvent,
  findings: readonly Finding[],
  acceptance?: PullRequestReviewAcceptance
): PullRequestReviewEvent {
  const hasFindings = findings.length > 0;
  const hasBlockingReasons = (acceptance?.blocking_reasons.length ?? 0) > 0;
  const wantsRequestChanges =
    acceptance?.recommended_action === "request_changes";
  const wantsApproval =
    acceptance?.status === "accepted" ||
    acceptance?.recommended_action === "approve";

  if (requestedEvent === "auto") {
    if (wantsRequestChanges && (hasFindings || hasBlockingReasons)) {
      return "request_changes";
    }

    if (hasFindings) {
      return "request_changes";
    }

    if (wantsApproval) {
      return "approve";
    }

    return "comment";
  }

  if (
    requestedEvent === "request_changes" &&
    !hasFindings &&
    !(wantsRequestChanges && hasBlockingReasons)
  ) {
    return "comment";
  }

  if (
    requestedEvent === "approve" &&
    (hasFindings || wantsRequestChanges || acceptance?.status === "rejected")
  ) {
    return "comment";
  }

  return requestedEvent;
}
