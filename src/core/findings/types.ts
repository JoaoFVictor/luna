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

export const FindingSchema = z
  .object({
    title: NonEmptyStringSchema,
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    confidence: z.enum(["high", "medium", "low"]),
    description: NonEmptyStringSchema,
    evidence: z.array(EvidenceRefSchema),
    recommendation: NonEmptyStringSchema
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

export const CodeReviewFindingsSchema = z
  .object({
    findings: z.array(FindingSchema),
    summary: z.string().optional()
  })
  .strict();
export type CodeReviewFindings = z.infer<typeof CodeReviewFindingsSchema>;
