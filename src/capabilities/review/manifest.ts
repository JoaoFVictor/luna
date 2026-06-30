import { capabilityManifest } from "../../core/capabilities/manifest.js";

const reviewRangeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "line_start", "line_end"],
  properties: {
    path: { type: "string", minLength: 1 },
    line_start: { type: "integer", minimum: 1 },
    line_end: { type: "integer", minimum: 1 }
  }
} as const;

const reviewedRangeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "line_start", "line_end"],
  properties: {
    path: { type: "string", minLength: 1 },
    line_start: { type: "integer", minimum: 1 },
    line_end: { type: "integer", minimum: 1 },
    notes: { type: "string", minLength: 1 },
    risk_tags: {
      type: "array",
      items: { type: "string", minLength: 1 }
    }
  }
} as const;

const blockedRangeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "reason"],
  properties: {
    path: { type: "string", minLength: 1 },
    reason: {
      type: "string",
      enum: [
        "binary",
        "deleted",
        "submodule",
        "diff_budget_exhausted",
        "patch_truncated",
        "patch_missing",
        "changed_files_truncated"
      ]
    },
    details: { type: "string" }
  }
} as const;

const coveragePlanOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "status",
    "expected_review_ranges",
    "blocked_ranges",
    "totals"
  ],
  properties: {
    summary: { type: "string" },
    status: { type: "string", enum: ["ready", "blocked"] },
    expected_review_ranges: {
      type: "array",
      items: reviewRangeSchema
    },
    blocked_ranges: {
      type: "array",
      items: blockedRangeSchema
    },
    totals: {
      type: "object",
      additionalProperties: false,
      required: ["changed_files", "expected_review_ranges", "blocked_ranges"],
      properties: {
        changed_files: { type: "integer", minimum: 0 },
        expected_review_ranges: { type: "integer", minimum: 0 },
        blocked_ranges: { type: "integer", minimum: 0 }
      }
    }
  }
} as const;

const coverageCheckOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "status",
    "expected_review_ranges",
    "reviewed_ranges",
    "missing_review_ranges",
    "blocked_ranges",
    "totals"
  ],
  properties: {
    summary: { type: "string" },
    status: { type: "string", enum: ["complete", "partial", "blocked"] },
    expected_review_ranges: {
      type: "array",
      items: reviewRangeSchema
    },
    reviewed_ranges: {
      type: "array",
      items: reviewedRangeSchema
    },
    missing_review_ranges: {
      type: "array",
      items: reviewRangeSchema
    },
    blocked_ranges: {
      type: "array",
      items: blockedRangeSchema
    },
    totals: {
      type: "object",
      additionalProperties: false,
      required: [
        "expected_review_ranges",
        "reviewed_ranges",
        "missing_review_ranges",
        "blocked_ranges"
      ],
      properties: {
        expected_review_ranges: { type: "integer", minimum: 0 },
        reviewed_ranges: { type: "integer", minimum: 0 },
        missing_review_ranges: { type: "integer", minimum: 0 },
        blocked_ranges: { type: "integer", minimum: 0 }
      }
    }
  }
} as const;

const reviewQualityReasonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "severity", "details"],
  properties: {
    code: {
      type: "string",
      enum: [
        "coverage_blocked",
        "coverage_partial",
        "weak_reviewed_range",
        "related_context_warning",
        "related_context_truncated",
        "unpublishable_finding"
      ]
    },
    severity: { type: "string", enum: ["info", "warning", "blocking"] },
    path: { type: "string", minLength: 1 },
    details: { type: "string", minLength: 1 }
  }
} as const;

const reviewQualityOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "status", "reasons", "signals"],
  properties: {
    summary: { type: "string" },
    status: { type: "string", enum: ["pass", "needs_human_review", "blocked"] },
    reasons: {
      type: "array",
      items: reviewQualityReasonSchema
    },
    signals: {
      type: "object",
      additionalProperties: false,
      required: [
        "coverage_status",
        "related_context_warnings",
        "related_context_truncated_paths",
        "findings",
        "publishable_findings"
      ],
      properties: {
        coverage_status: {
          type: "string",
          enum: ["complete", "partial", "blocked", "unknown"]
        },
        related_context_warnings: { type: "integer", minimum: 0 },
        related_context_truncated_paths: { type: "integer", minimum: 0 },
        findings: { type: "integer", minimum: 0 },
        publishable_findings: { type: "integer", minimum: 0 }
      }
    }
  }
} as const;

const coverageCheckReviewResultSchema = {
  type: "object",
  additionalProperties: true,
  required: ["reviewed_ranges"],
  properties: {
    reviewed_ranges: {
      type: "array",
      items: reviewedRangeSchema
    }
  }
} as const;

export const manifest = capabilityManifest({
  id: "review",
  kind: "execution",
  version: "2026.06.29",
  built_ins: {
    "review.coverage_plan": {
      id: "review.coverage_plan",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["repo_context"],
        properties: {
          repo_context: {}
        }
      },
      output_schema: coveragePlanOutputSchema,
      required_ports: []
    },
    "review.coverage_check": {
      id: "review.coverage_check",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["coverage_plan", "review_result"],
        properties: {
          coverage_plan: coveragePlanOutputSchema,
          review_result: coverageCheckReviewResultSchema
        }
      },
      output_schema: coverageCheckOutputSchema,
      required_ports: []
    },
    "review.quality_check": {
      id: "review.quality_check",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          coverage: coverageCheckOutputSchema,
          related_context: {},
          findings: {}
        }
      },
      output_schema: reviewQualityOutputSchema,
      required_ports: []
    }
  },
  docs: [{ title: "Review coverage planning, verification, and quality checks" }]
});
