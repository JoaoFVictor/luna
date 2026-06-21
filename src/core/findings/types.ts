import { z } from "zod";
import { InvocationSchema, WorkspaceRecordSchema } from "../types.js";

const NonEmptyStringSchema = z.string().min(1);

export const ReviewPlanSchema = z
  .object({
    summary: NonEmptyStringSchema,
    focus_areas: z.array(NonEmptyStringSchema),
    files_to_review: z.array(NonEmptyStringSchema)
  })
  .strict();
export type ReviewPlan = z.infer<typeof ReviewPlanSchema>;

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

export const AcceptanceDecisionSchema = z
  .object({
    status: z.enum(["accepted", "rejected", "needs_human_review"]),
    summary: NonEmptyStringSchema,
    blocking_reasons: z.array(NonEmptyStringSchema),
    recommended_action: z.enum([
      "approve",
      "comment",
      "request_changes",
      "continue",
      "stop",
      "human_review"
    ])
  })
  .strict();
export type AcceptanceDecision = z.infer<typeof AcceptanceDecisionSchema>;

export const FinalReportSchema = z
  .object({
    invocation: InvocationSchema,
    plan: ReviewPlanSchema,
    findings: CodeReviewFindingsSchema,
    acceptance: AcceptanceDecisionSchema,
    workspace: WorkspaceRecordSchema.optional()
  })
  .strict();
export type FinalReport = z.infer<typeof FinalReportSchema>;
