import { z } from "zod"

import {
  ArtifactViewNonEmptyTextSchema,
  ArtifactViewTextSchema,
  MAX_ARTIFACT_VIEW_ITEMS,
  RepositoryRelativePathSchema,
} from "./common"

const CountSchema = z.number().int().safe().nonnegative()
const LineSchema = z.number().int().safe().positive()

const EvidenceSchema = z
  .object({
    path: RepositoryRelativePathSchema,
    line_start: LineSchema,
    line_end: LineSchema,
    quote: ArtifactViewTextSchema.optional(),
  })
  .strict()
  .refine((value) => value.line_end >= value.line_start, {
    path: ["line_end"],
    message: "line_end must not precede line_start",
  })

const FindingSchema = z
  .object({
    title: ArtifactViewNonEmptyTextSchema,
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    confidence: z.enum(["high", "medium", "low"]),
    description: ArtifactViewNonEmptyTextSchema,
    evidence: z.array(EvidenceSchema).max(100),
    recommendation: ArtifactViewNonEmptyTextSchema,
    category: z
      .enum([
        "security",
        "architecture",
        "bug",
        "maintainability",
        "compatibility",
        "other",
      ])
      .optional(),
    fingerprint: ArtifactViewNonEmptyTextSchema.optional(),
    sources: z.array(ArtifactViewNonEmptyTextSchema).max(100).optional(),
    merged_from: z.number().int().safe().positive().optional(),
  })
  .strict()

const ReviewedRangeSchema = z
  .object({
    path: RepositoryRelativePathSchema,
    line_start: LineSchema,
    line_end: LineSchema,
    notes: ArtifactViewNonEmptyTextSchema.optional(),
    risk_tags: z.array(ArtifactViewNonEmptyTextSchema).max(100).optional(),
  })
  .strict()
  .refine((value) => value.line_end >= value.line_start, {
    path: ["line_end"],
    message: "line_end must not precede line_start",
  })

export const ReviewFindingsViewSchema = z
  .object({
    summary: ArtifactViewTextSchema.optional(),
    findings: z.array(FindingSchema).max(MAX_ARTIFACT_VIEW_ITEMS),
    reviewed_ranges: z
      .array(ReviewedRangeSchema)
      .max(MAX_ARTIFACT_VIEW_ITEMS)
      .optional(),
  })
  .strict()
  .transform((value) => ({
    summary: value.summary,
    reviewed_range_count: value.reviewed_ranges?.length ?? 0,
    findings: value.findings.map((finding) => ({
      title: finding.title,
      severity: finding.severity,
      confidence: finding.confidence,
      description: finding.description,
      recommendation: finding.recommendation,
      category: finding.category,
      evidence: finding.evidence.map((evidence) => ({
        path: evidence.path,
        line_start: evidence.line_start,
        line_end: evidence.line_end,
      })),
    })),
  }))

const ReviewRangeSchema = z
  .object({
    path: RepositoryRelativePathSchema,
    line_start: LineSchema,
    line_end: LineSchema,
  })
  .strict()
  .refine((value) => value.line_end >= value.line_start, {
    path: ["line_end"],
    message: "line_end must not precede line_start",
  })

const BlockedRangeSchema = z
  .object({
    path: z.union([RepositoryRelativePathSchema, z.literal("*")]),
    reason: z.enum([
      "binary",
      "deleted",
      "submodule",
      "diff_budget_exhausted",
      "patch_truncated",
      "patch_missing",
      "changed_files_truncated",
    ]),
    details: ArtifactViewTextSchema.optional(),
  })
  .strict()

const CoveragePlanSchema = z
  .object({
    summary: ArtifactViewTextSchema,
    status: z.enum(["ready", "blocked"]),
    expected_review_ranges: z.array(ReviewRangeSchema).max(MAX_ARTIFACT_VIEW_ITEMS),
    blocked_ranges: z.array(BlockedRangeSchema).max(MAX_ARTIFACT_VIEW_ITEMS),
    totals: z
      .object({
        changed_files: CountSchema,
        expected_review_ranges: CountSchema,
        blocked_ranges: CountSchema,
      })
      .strict(),
  })
  .strict()
  .transform((value) => ({
    kind: "plan" as const,
    summary: value.summary,
    status: value.status,
    metrics: [
      { label: "Arquivos alterados", value: value.totals.changed_files },
      { label: "Faixas esperadas", value: value.totals.expected_review_ranges },
      { label: "Faixas bloqueadas", value: value.totals.blocked_ranges },
    ],
    blocked_ranges: value.blocked_ranges,
    missing_ranges: [] as z.infer<typeof ReviewRangeSchema>[],
  }))

const CoverageCheckSchema = z
  .object({
    summary: ArtifactViewTextSchema,
    status: z.enum(["complete", "partial", "blocked"]),
    expected_review_ranges: z.array(ReviewRangeSchema).max(MAX_ARTIFACT_VIEW_ITEMS),
    reviewed_ranges: z.array(ReviewedRangeSchema).max(MAX_ARTIFACT_VIEW_ITEMS),
    missing_review_ranges: z.array(ReviewRangeSchema).max(MAX_ARTIFACT_VIEW_ITEMS),
    blocked_ranges: z.array(BlockedRangeSchema).max(MAX_ARTIFACT_VIEW_ITEMS),
    totals: z
      .object({
        expected_review_ranges: CountSchema,
        reviewed_ranges: CountSchema,
        missing_review_ranges: CountSchema,
        blocked_ranges: CountSchema,
      })
      .strict(),
  })
  .strict()
  .transform((value) => ({
    kind: "check" as const,
    summary: value.summary,
    status: value.status,
    metrics: [
      { label: "Faixas esperadas", value: value.totals.expected_review_ranges },
      { label: "Faixas revisadas", value: value.totals.reviewed_ranges },
      { label: "Faixas ausentes", value: value.totals.missing_review_ranges },
      { label: "Faixas bloqueadas", value: value.totals.blocked_ranges },
    ],
    blocked_ranges: value.blocked_ranges,
    missing_ranges: value.missing_review_ranges,
  }))

export const ReviewCoveragePlanViewSchema = CoveragePlanSchema
export const ReviewCoverageCheckViewSchema = CoverageCheckSchema

export const ReviewAcceptanceViewSchema = z
  .object({
    status: z.enum(["accepted", "rejected", "needs_human_review"]),
    summary: ArtifactViewNonEmptyTextSchema,
    blocking_reasons: z
      .array(ArtifactViewNonEmptyTextSchema)
      .max(MAX_ARTIFACT_VIEW_ITEMS),
    recommended_action: z.enum([
      "approve",
      "comment",
      "request_changes",
      "continue",
      "stop",
      "human_review",
    ]),
  })
  .strict()

const ProviderPublishSuccessSchema = z
  .object({
    operation_id: z.literal("pull-request-review.publish"),
    enabled: z.literal(true),
    skipped: z.literal(false),
    provider: ArtifactViewNonEmptyTextSchema,
    provider_id: ArtifactViewNonEmptyTextSchema,
    external_id: ArtifactViewNonEmptyTextSchema,
    url: z.string().min(1).max(2_048),
    event: z.enum(["comment", "request_changes", "approve"]),
    inline_comments: CountSchema,
    fallback_comments: CountSchema,
  })
  .strict()
  .transform((value) => ({
    status: "published" as const,
    provider: value.provider,
    external_id: value.external_id,
    event: value.event,
    inline_comments: value.inline_comments,
    fallback_comments: value.fallback_comments,
  }))

const ProviderPublishSkippedSchema = z
  .object({
    operation_id: z.literal("pull-request-review.publish"),
    enabled: z.boolean(),
    skipped: z.literal(true),
    reason: ArtifactViewNonEmptyTextSchema,
    error: z
      .object({
        code: ArtifactViewTextSchema.optional(),
        message: ArtifactViewNonEmptyTextSchema,
        details: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .transform((value) => ({
    status: "skipped" as const,
    enabled: value.enabled,
    reason: value.reason,
  }))

export const ReviewProviderPublishViewSchema = z.union([
  ProviderPublishSuccessSchema,
  ProviderPublishSkippedSchema,
])
