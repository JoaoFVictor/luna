import { z } from "zod";
import { StudioDraftTestDataSelectionsSchema } from "./manual-test-data.js";
import { StudioRunPlanInputSchema } from "./run-plan-input.js";

export const StudioDraftTestRunPlanInputSchema = z
  .object({
    input: StudioRunPlanInputSchema,
    test_data: StudioDraftTestDataSelectionsSchema.optional()
  })
  .strict()
  .superRefine((request, context) => {
    if (request.input.definition_source.kind !== "draft") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input", "definition_source"],
        message: "Draft test plans require an exact workflow draft revision"
      });
    }
  });
export type StudioDraftTestRunPlanInput = z.infer<
  typeof StudioDraftTestRunPlanInputSchema
>;
