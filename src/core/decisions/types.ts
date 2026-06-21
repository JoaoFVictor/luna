import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

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
