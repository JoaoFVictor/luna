import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);
const AbsoluteUrlSchema = z.string().url();

export const RouteTargetSchema = z
  .object({
    type: z.literal("workflow"),
    id: NonEmptyStringSchema
  })
  .strict();
export type RouteTarget = z.infer<typeof RouteTargetSchema>;

export const InvocationRepositorySchema = z
  .object({
    provider: NonEmptyStringSchema,
    owner: NonEmptyStringSchema,
    name: NonEmptyStringSchema
  })
  .strict();
export type InvocationRepository = z.infer<typeof InvocationRepositorySchema>;

export const InvocationSubjectSchema = z
  .object({
    type: NonEmptyStringSchema,
    id: NonEmptyStringSchema,
    url: AbsoluteUrlSchema.optional(),
    title: NonEmptyStringSchema.optional()
  })
  .strict();
export type InvocationSubject = z.infer<typeof InvocationSubjectSchema>;

export const InvocationActorSchema = z
  .object({
    id: NonEmptyStringSchema.optional(),
    display_name: NonEmptyStringSchema.optional()
  })
  .strict();
export type InvocationActor = z.infer<typeof InvocationActorSchema>;

export const NormalizedInvocationSchema = z
  .object({
    version: z.literal("2026-06"),
    source: NonEmptyStringSchema,
    event: NonEmptyStringSchema,
    action: NonEmptyStringSchema.optional(),
    target: RouteTargetSchema.optional(),
    repository: InvocationRepositorySchema.optional(),
    subject: InvocationSubjectSchema.optional(),
    actor: InvocationActorSchema.optional(),
    references: z.record(NonEmptyStringSchema, NonEmptyStringSchema).optional(),
    payload: z.record(NonEmptyStringSchema, z.unknown()).optional()
  })
  .strict();
export type NormalizedInvocation = z.infer<typeof NormalizedInvocationSchema>;

export const InvocationSchema = NormalizedInvocationSchema;
export type Invocation = NormalizedInvocation;

export const RouteWhenSchema = z
  .object({
    has_target: z.boolean().optional(),
    source: NonEmptyStringSchema.optional(),
    event: NonEmptyStringSchema.optional(),
    event_in: z.array(NonEmptyStringSchema).optional(),
    action: NonEmptyStringSchema.optional(),
    action_in: z.array(NonEmptyStringSchema).optional()
  })
  .strict()
  .superRefine((when, context) => {
    if (when.event !== undefined && when.event_in !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "event and event_in cannot be used together",
        path: ["event"]
      });
    }

    if (when.action !== undefined && when.action_in !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "action and action_in cannot be used together",
        path: ["action"]
      });
    }
  });
export type RouteWhen = z.infer<typeof RouteWhenSchema>;

export const RouteSchema = z
  .object({
    name: NonEmptyStringSchema,
    when: RouteWhenSchema,
    use_target_from_input: z.boolean().optional(),
    target: RouteTargetSchema.optional()
  })
  .strict();
export type Route = z.infer<typeof RouteSchema>;

export const RoutingConfigSchema = z
  .object({
    routes: z.array(RouteSchema)
  })
  .strict();
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

export const RunIdentitySchema = z
  .object({
    run_id: NonEmptyStringSchema,
    flue_run_id: NonEmptyStringSchema.optional(),
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
