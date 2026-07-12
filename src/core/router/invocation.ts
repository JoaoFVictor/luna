import { z } from "zod";
import { remoteUrlContainsCredentials } from "../security/url-credentials.js";

const NonEmptyStringSchema = z.string().min(1);
const AbsoluteUrlSchema = z.string().url().refine(
  (value) => !remoteUrlContainsCredentials(value),
  "URL must not contain credentials"
);
export const WORKFLOW_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]*$";
export const WorkflowIdSchema = z.string().regex(new RegExp(WORKFLOW_ID_PATTERN));

export const RouteTargetSchema = z
  .object({
    type: z.literal("workflow"),
    id: WorkflowIdSchema
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

export const InvocationEnvelopeSchema = z
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

export type InvocationEnvelope = z.infer<typeof InvocationEnvelopeSchema>;
export type NormalizedInvocation = InvocationEnvelope;

export const InvocationSchema = InvocationEnvelopeSchema;
export type Invocation = InvocationEnvelope;
