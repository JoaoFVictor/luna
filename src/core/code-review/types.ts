import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

export const ReviewPlanSchema = z
  .object({
    summary: NonEmptyStringSchema,
    focus_areas: z.array(NonEmptyStringSchema),
    files_to_review: z.array(NonEmptyStringSchema)
  })
  .strict();
export type ReviewPlan = z.infer<typeof ReviewPlanSchema>;
