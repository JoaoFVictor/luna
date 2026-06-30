import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

export const EvidenceRefSchema = z
  .object({
    path: NonEmptyStringSchema,
    line_start: z.number().int().positive(),
    line_end: z.number().int().positive(),
    quote: z.string().optional()
  })
  .strict()
  .refine((evidence) => evidence.line_end >= evidence.line_start, {
    message: "line_end must be greater than or equal to line_start",
    path: ["line_end"]
  });
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

const ReviewRangeRefBaseSchema = z.object({
  path: NonEmptyStringSchema,
  line_start: z.number().int().positive(),
  line_end: z.number().int().positive()
});

export const ReviewRangeRefSchema = ReviewRangeRefBaseSchema
  .strict()
  .refine((range) => range.line_end >= range.line_start, {
    message: "line_end must be greater than or equal to line_start",
    path: ["line_end"]
  });
export type ReviewRangeRef = z.infer<typeof ReviewRangeRefSchema>;

export const ReviewedRangeRefSchema = ReviewRangeRefBaseSchema.extend({
  notes: NonEmptyStringSchema.optional(),
  risk_tags: z.array(NonEmptyStringSchema).optional()
})
  .strict()
  .refine((range) => range.line_end >= range.line_start, {
    message: "line_end must be greater than or equal to line_start",
    path: ["line_end"]
  });
export type ReviewedRangeRef = z.infer<typeof ReviewedRangeRefSchema>;

export const FindingSchema = z
  .object({
    title: NonEmptyStringSchema,
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    confidence: z.enum(["high", "medium", "low"]),
    description: NonEmptyStringSchema,
    evidence: z.array(EvidenceRefSchema),
    recommendation: NonEmptyStringSchema,
    category: z
      .enum([
        "security",
        "architecture",
        "bug",
        "maintainability",
        "compatibility",
        "other"
      ])
      .optional(),
    fingerprint: NonEmptyStringSchema.optional(),
    sources: z.array(NonEmptyStringSchema).optional(),
    merged_from: z.number().int().positive().optional()
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

export const FindingsPayloadSchema = z
  .object({
    findings: z.array(FindingSchema),
    reviewed_ranges: z.array(ReviewedRangeRefSchema).optional(),
    summary: z.string().optional()
  })
  .strict();
export type FindingsPayload = z.infer<typeof FindingsPayloadSchema>;

export const FindingsReviewOutputSchema = FindingsPayloadSchema.extend({
  reviewed_ranges: z.array(ReviewedRangeRefSchema)
}).strict();
export type FindingsReviewOutput = z.infer<typeof FindingsReviewOutputSchema>;
