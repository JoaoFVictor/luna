import { z } from "zod";
import { RouteTargetSchema } from "../router/invocation.js";

const NonEmptyStringSchema = z.string().min(1);

export const RunIdentitySchema = z
  .object({
    run_id: NonEmptyStringSchema,
    runtime_run_id: NonEmptyStringSchema.optional(),
    workflow_id: NonEmptyStringSchema,
    attempt: z.number().int().positive(),
    source: NonEmptyStringSchema,
    event: NonEmptyStringSchema,
    action: NonEmptyStringSchema.optional(),
    route_target: RouteTargetSchema.optional(),
    subject: z
      .object({
        type: NonEmptyStringSchema,
        id: NonEmptyStringSchema
      })
      .strict()
      .optional(),
    started_at: NonEmptyStringSchema
  })
  .strict();
export type RunIdentity = z.infer<typeof RunIdentitySchema>;
