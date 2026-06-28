import { z } from "zod";
import { RepositoryHintLabelConfigSchema } from "../repository-hints/github-full-name.js";

const NonEmptyStringSchema = z.string().min(1);

export const PlaneConfigSchema = z
  .object({
    instances: z.array(
      z
        .object({
          id: NonEmptyStringSchema,
          base_url: NonEmptyStringSchema,
          repository_hint: RepositoryHintLabelConfigSchema.optional()
        })
        .strict()
    )
  })
  .strict();
export type PlaneConfig = z.infer<typeof PlaneConfigSchema>;
