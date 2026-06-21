import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

const JiraFieldConfigSchema = z
  .object({
    field_id: NonEmptyStringSchema,
    format: NonEmptyStringSchema
  })
  .strict();

export const JiraConfigSchema = z
  .object({
    instances: z.array(
      z
        .object({
          id: NonEmptyStringSchema,
          base_url: NonEmptyStringSchema,
          repository_field: JiraFieldConfigSchema,
          acceptance_criteria_field: JiraFieldConfigSchema.optional()
        })
        .strict()
    )
  })
  .strict();
export type JiraConfig = z.infer<typeof JiraConfigSchema>;

