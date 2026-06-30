import { z } from "zod";
import type { RepoContext } from "../git/diff/types.js";
import { RepoContextSchema } from "../git/diff/types.js";
import { RelatedContextSchema } from "../repository-context/contracts.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import { builtInError } from "../../core/built-ins/errors.js";
import { requiredInput } from "../../core/built-ins/state.js";
import { FindingsPayloadSchema } from "../../core/findings/types.js";
import { rightSideRangesFromPatch } from "../../core/repository/diff-hunks.js";
import type {
  ReviewedRangeRef,
  ReviewRangeRef
} from "../../core/findings/types.js";
import {
  ReviewedRangeRefSchema,
  ReviewRangeRefSchema
} from "../../core/findings/types.js";

type ReviewRange = ReviewRangeRef;
type ReviewedRange = ReviewedRangeRef;

const ReviewBlockedRangeSchema = z
  .object({
    path: z.string().min(1),
    reason: z.enum([
      "binary",
      "deleted",
      "submodule",
      "diff_budget_exhausted",
      "patch_truncated",
      "patch_missing",
      "changed_files_truncated"
    ]),
    details: z.string().optional()
  })
  .strict();
type ReviewBlockedRange = z.infer<typeof ReviewBlockedRangeSchema>;

const ReviewCoveragePlanSchema = z
  .object({
    summary: z.string(),
    status: z.enum(["ready", "blocked"]),
    expected_review_ranges: z.array(ReviewRangeRefSchema),
    blocked_ranges: z.array(ReviewBlockedRangeSchema),
    totals: z
      .object({
        changed_files: z.number().int().nonnegative(),
        expected_review_ranges: z.number().int().nonnegative(),
        blocked_ranges: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();
type ReviewCoveragePlan = z.infer<typeof ReviewCoveragePlanSchema>;

const ReviewCoverageCheckInputSchema = z
  .object({
    coverage_plan: ReviewCoveragePlanSchema.optional(),
    review_result: z.unknown().optional()
  })
  .strict();
type ReviewCoverageCheckInput = {
  readonly coverage_plan?: ReviewCoveragePlan;
  readonly review_result?: unknown;
};

const ReviewQualityReasonSchema = z
  .object({
    code: z.enum([
      "coverage_blocked",
      "coverage_partial",
      "weak_reviewed_range",
      "related_context_warning",
      "related_context_truncated",
      "unpublishable_finding"
    ]),
    severity: z.enum(["info", "warning", "blocking"]),
    path: z.string().min(1).optional(),
    details: z.string().min(1)
  })
  .strict();
type ReviewQualityReason = z.infer<typeof ReviewQualityReasonSchema>;

const ReviewQualityCheckInputSchema = z
  .object({
    coverage: coverageCheckOutputSchema().optional(),
    related_context: RelatedContextSchema.optional(),
    findings: FindingsPayloadSchema.optional()
  })
  .strict();

type ReviewQualityCheckInput = z.infer<typeof ReviewQualityCheckInputSchema>;

const ReviewResultWithReviewedRangesSchema = z
  .object({
    reviewed_ranges: z.array(ReviewedRangeRefSchema)
  })
  .passthrough();

function coverageCheckOutputSchema() {
  return z
    .object({
      summary: z.string(),
      status: z.enum(["complete", "partial", "blocked"]),
      expected_review_ranges: z.array(ReviewRangeRefSchema),
      reviewed_ranges: z.array(ReviewedRangeRefSchema),
      missing_review_ranges: z.array(ReviewRangeRefSchema),
      blocked_ranges: z.array(ReviewBlockedRangeSchema),
      totals: z
        .object({
          expected_review_ranges: z.number().int().nonnegative(),
          reviewed_ranges: z.number().int().nonnegative(),
          missing_review_ranges: z.number().int().nonnegative(),
          blocked_ranges: z.number().int().nonnegative()
        })
        .strict()
    })
    .strict();
}

function repoContextFrom(input: unknown): RepoContext {
  const record = objectRecord(input);
  if (record === undefined) {
    return requiredInput<RepoContext>(undefined, "repo_context");
  }

  const repoContext = requiredInput(record.repo_context, "repo_context");
  const parsed = RepoContextSchema.safeParse(repoContext);
  if (!parsed.success) {
    throw builtInError(
      "review.coverage_plan repo_context must match the repository context schema.",
      "built_in_input_invalid"
    );
  }

  return parsed.data;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function coverageCheckInputFrom(input: unknown): ReviewCoverageCheckInput {
  if (input === undefined) {
    return requiredInput<ReviewCoverageCheckInput>(undefined, "coverage_check");
  }

  const parsed = ReviewCoverageCheckInputSchema.safeParse(input);
  if (!parsed.success) {
    throw builtInError(
      "review.coverage_check input must match the coverage check schema.",
      "built_in_input_invalid"
    );
  }

  return parsed.data;
}

function qualityCheckInputFrom(input: unknown): ReviewQualityCheckInput {
  if (input === undefined) {
    return requiredInput<ReviewQualityCheckInput>(undefined, "review_quality");
  }

  const parsed = ReviewQualityCheckInputSchema.safeParse(input);
  if (!parsed.success) {
    throw builtInError(
      "review.quality_check input must match the review quality schema.",
      "built_in_input_invalid"
    );
  }

  return parsed.data;
}

function planSummary(plan: Omit<ReviewCoveragePlan, "summary">): string {
  const expectedReviewRangeLabel = pluralize(
    plan.expected_review_ranges.length,
    "expected review range"
  );
  if (plan.status === "blocked") {
    const blockedRangeLabel = pluralize(plan.blocked_ranges.length, "blocked range");
    return `Review coverage plan has ${plan.expected_review_ranges.length} ${expectedReviewRangeLabel} and ${plan.blocked_ranges.length} ${blockedRangeLabel}.`;
  }

  return `Review coverage plan has ${plan.expected_review_ranges.length} ${expectedReviewRangeLabel}.`;
}

function blockedSummary(check: {
  readonly status: "complete" | "partial" | "blocked";
  readonly missing_review_ranges: readonly ReviewRange[];
  readonly blocked_ranges: readonly ReviewBlockedRange[];
}): string {
  if (check.status === "blocked") {
    const missingReviewRangeLabel = pluralize(
      check.missing_review_ranges.length,
      "missing review range"
    );
    const blockedRangeLabel = pluralize(check.blocked_ranges.length, "blocked range");
    return `Review coverage is blocked: ${check.missing_review_ranges.length} ${missingReviewRangeLabel} and ${check.blocked_ranges.length} ${blockedRangeLabel}.`;
  }

  if (check.status === "partial") {
    const expectedReviewRangeLabel = pluralize(
      check.missing_review_ranges.length,
      "expected review range"
    );
    const verb = check.missing_review_ranges.length === 1 ? "was" : "were";
    return `Review coverage is partial: ${check.missing_review_ranges.length} ${expectedReviewRangeLabel} ${verb} not reported as reviewed.`;
  }

  return "Review coverage is complete.";
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function qualitySummary(status: "pass" | "needs_human_review" | "blocked", reasonCount: number): string {
  if (status === "blocked") {
    return `Review quality is blocked by ${reasonCount} deterministic ${pluralize(reasonCount, "reason")}.`;
  }
  if (status === "needs_human_review") {
    return `Review quality needs human review due to ${reasonCount} deterministic ${pluralize(reasonCount, "signal")}.`;
  }
  return "Review quality passed deterministic checks.";
}

function coversRange(reviewed: ReviewRange, expected: ReviewRange): boolean {
  return (
    reviewed.path === expected.path &&
    reviewed.line_start <= expected.line_start &&
    reviewed.line_end >= expected.line_end
  );
}

function missingRanges(
  expectedRanges: readonly ReviewRange[],
  reviewedRanges: readonly ReviewedRange[]
): readonly ReviewRange[] {
  return expectedRanges.filter((expected) =>
    !reviewedRanges.some((reviewed) => coversRange(reviewed, expected))
  );
}

function reviewedRangesFrom(
  reviewResult: ReviewCoverageCheckInput["review_result"]
): readonly ReviewedRange[] {
  const parsed = ReviewResultWithReviewedRangesSchema.safeParse(reviewResult);
  if (!parsed.success) {
    throw builtInError(
      "review.coverage_check review_result must include reviewed_ranges.",
      "built_in_input_invalid"
    );
  }

  return parsed.data.reviewed_ranges;
}

export const coveragePlanBuiltIn = defineBuiltInStep<"review.coverage_plan">({
  name: "review.coverage_plan",
  run({ input }) {
    const repoContext = repoContextFrom(input);
    const expectedReviewRanges: ReviewRange[] = [];
    const blockedRanges: ReviewBlockedRange[] = [];

    for (const file of repoContext.files) {
      if (file.patch !== null && file.patch !== undefined) {
        expectedReviewRanges.push(...rightSideRangesFromPatch(file.patch).map((range) => ({
          path: file.path,
          ...range
        })));
      } else {
        blockedRanges.push({
          path: file.path,
          reason: file.patch_omitted_reason ?? "patch_missing"
        });
      }

      if (file.patch_truncated === true) {
        blockedRanges.push({
          path: file.path,
          reason: "patch_truncated"
        });
      }
    }

    if (repoContext.changed_files_truncated === true) {
      blockedRanges.push({
        path: "*",
        reason: "changed_files_truncated",
        details: `${repoContext.files.length} of ${repoContext.total_changed_files ?? "unknown"} changed files were captured.`
      });
    }

    const plan = {
      status: blockedRanges.length === 0 ? "ready" as const : "blocked" as const,
      expected_review_ranges: expectedReviewRanges,
      blocked_ranges: blockedRanges,
      totals: {
        changed_files: repoContext.files.length,
        expected_review_ranges: expectedReviewRanges.length,
        blocked_ranges: blockedRanges.length
      }
    };

    return {
      summary: planSummary(plan),
      ...plan
    };
  }
});

export const coverageCheckBuiltIn = defineBuiltInStep<"review.coverage_check">({
  name: "review.coverage_check",
  run({ input }) {
    const resolved = coverageCheckInputFrom(input);
    const coveragePlan = requiredInput(
      resolved.coverage_plan,
      "coverage_plan"
    );
    const reviewResult = requiredInput(
      resolved.review_result,
      "review_result"
    );
    const reviewedRanges = reviewedRangesFrom(reviewResult);
    const missing = missingRanges(
      coveragePlan.expected_review_ranges,
      reviewedRanges
    );
    const status: "complete" | "partial" | "blocked" =
      coveragePlan.blocked_ranges.length > 0
        ? "blocked"
        : missing.length > 0
          ? "partial"
          : "complete";
    const check = {
      status,
      expected_review_ranges: coveragePlan.expected_review_ranges,
      reviewed_ranges: reviewedRanges,
      missing_review_ranges: missing,
      blocked_ranges: coveragePlan.blocked_ranges,
      totals: {
        expected_review_ranges: coveragePlan.expected_review_ranges.length,
        reviewed_ranges: reviewedRanges.length,
        missing_review_ranges: missing.length,
        blocked_ranges: coveragePlan.blocked_ranges.length
      }
    };

    return {
      summary: blockedSummary(check),
      ...check
    };
  }
});

export const qualityCheckBuiltIn = defineBuiltInStep<"review.quality_check">({
  name: "review.quality_check",
  run({ input }) {
    const resolved = qualityCheckInputFrom(input);
    const reasons: ReviewQualityReason[] = [];

    if (resolved.coverage !== undefined) {
      if (resolved.coverage.status === "blocked") {
        for (const blocked of resolved.coverage.blocked_ranges) {
          reasons.push({
            code: "coverage_blocked",
            severity: "blocking",
            path: blocked.path,
            details: blocked.details ?? `Coverage blocked because ${blocked.reason}.`
          });
        }
      } else if (resolved.coverage.status === "partial") {
        for (const missing of resolved.coverage.missing_review_ranges) {
          reasons.push({
            code: "coverage_partial",
            severity: "blocking",
            path: missing.path,
            details: `Missing reviewed range ${missing.path}:${missing.line_start}-${missing.line_end}.`
          });
        }
      }

      for (const reviewed of resolved.coverage.reviewed_ranges) {
        if (
          reviewed.notes === undefined ||
          reviewed.risk_tags === undefined ||
          reviewed.risk_tags.length === 0
        ) {
          reasons.push({
            code: "weak_reviewed_range",
            severity: "warning",
            path: reviewed.path,
            details:
              `Reviewed range ${reviewed.path}:${reviewed.line_start}-${reviewed.line_end} lacks notes or risk tags.`
          });
        }
      }
    }

    if (resolved.related_context !== undefined) {
      for (const warning of resolved.related_context.audit.warnings) {
        reasons.push({
          code: "related_context_warning",
          severity: warning.includes("AST bridge unavailable") ? "info" : "warning",
          details: warning
        });
      }

      for (const truncatedPath of resolved.related_context.truncation.truncated_paths) {
        reasons.push({
          code: "related_context_truncated",
          severity: "info",
          path: truncatedPath,
          details: "Related context excerpt was truncated for this path."
        });
      }
    }

    if (resolved.findings !== undefined) {
      for (const finding of resolved.findings.findings) {
        if (finding.evidence.length === 0) {
          reasons.push({
            code: "unpublishable_finding",
            severity: "warning",
            details: `Finding "${finding.title}" has no evidence and cannot be published.`
          });
        }
      }
    }

    const blockingReasons = reasons.filter((reason) => reason.severity === "blocking");
    const warningReasons = reasons.filter((reason) => reason.severity === "warning");
    const status: "pass" | "needs_human_review" | "blocked" =
      blockingReasons.length > 0
        ? "blocked"
        : warningReasons.length > 0
          ? "needs_human_review"
          : "pass";

    return {
      summary: qualitySummary(status, reasons.length),
      status,
      reasons,
      signals: {
        coverage_status: resolved.coverage?.status ?? "unknown",
        related_context_warnings: resolved.related_context?.audit.warnings.length ?? 0,
        related_context_truncated_paths:
          resolved.related_context?.truncation.truncated_paths.length ?? 0,
        findings: resolved.findings?.findings.length ?? 0,
        publishable_findings:
          resolved.findings?.findings.filter((finding) => finding.evidence.length > 0).length ?? 0
      }
    };
  }
});
