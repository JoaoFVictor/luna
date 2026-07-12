import { z } from "zod";
import { StudioDigestSchema } from "./digests.js";
import { StudioPathSchema, StudioResourceRefSchema } from "./paths.js";

export const StudioApplyPlanTokenSchema = z.string().min(32).max(256);
const ApplyOperationIdSchema = z.string().uuid();

export const StudioApplyDiffKindSchema = z.enum([
  "created",
  "modified",
  "deleted"
]);
export type StudioApplyDiffKind = z.infer<
  typeof StudioApplyDiffKindSchema
>;

export const StudioApplyFileDiffSchema = z
  .object({
    file: StudioPathSchema,
    kind: StudioApplyDiffKindSchema,
    before_sha256: StudioDigestSchema.nullable(),
    after_sha256: StudioDigestSchema.nullable(),
    before_mode: z.number().int().min(0).max(0o777).nullable(),
    after_mode: z.number().int().min(0).max(0o777).nullable(),
    textual_diff: z.string().max(262_144),
    textual_diff_truncated: z.boolean(),
    redacted: z.literal(true)
  })
  .strict();
export type StudioApplyFileDiff = z.infer<
  typeof StudioApplyFileDiffSchema
>;

export const StudioApplyConflictSchema = z
  .object({
    file: StudioPathSchema,
    kind: StudioApplyDiffKindSchema,
    expected_sha256: StudioDigestSchema.nullable(),
    actual_sha256: StudioDigestSchema.nullable(),
    expected_mode: z.number().int().min(0).max(0o777).nullable().optional(),
    actual_mode: z.number().int().min(0).max(0o777).nullable().optional()
  })
  .strict()
  .superRefine((conflict, context) => {
    if (
      (conflict.expected_mode === undefined) !==
      (conflict.actual_mode === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Conflict modes must both be present or absent"
      });
    }
  });
export type StudioApplyConflict = z.infer<
  typeof StudioApplyConflictSchema
>;

const StudioApplyPlanBaseSchema = z
  .object({
    draft_id: z.string().uuid(),
    record_revision: z.number().int().safe().positive(),
    content_revision: z.number().int().safe().positive(),
    draft_hash: StudioDigestSchema,
    diff: z.array(StudioApplyFileDiffSchema),
    conflicts: z.array(StudioApplyConflictSchema),
    resources: z.array(StudioResourceRefSchema).min(1)
  })
  .strict();

const StudioReadyApplyPlanSchema = StudioApplyPlanBaseSchema.extend({
  status: z.literal("ready"),
  conflicts: z.array(StudioApplyConflictSchema).length(0),
  plan_token: StudioApplyPlanTokenSchema,
  expires_at: z.string().datetime({ offset: true })
}).strict();

const StudioConflictedApplyPlanSchema = StudioApplyPlanBaseSchema.extend({
  status: z.literal("conflicted"),
  conflicts: z.array(StudioApplyConflictSchema).min(1)
}).strict();

export const StudioApplyPlanResponseSchema = z.discriminatedUnion("status", [
  StudioReadyApplyPlanSchema,
  StudioConflictedApplyPlanSchema
]);
export type StudioApplyPlanResponse = z.infer<
  typeof StudioApplyPlanResponseSchema
>;

export const StudioApplyFileRevisionSchema = z
  .object({
    file: StudioPathSchema,
    sha256: StudioDigestSchema.nullable()
  })
  .strict();
export type StudioApplyFileRevision = z.infer<
  typeof StudioApplyFileRevisionSchema
>;

export const StudioApplyResultSchema = z
  .object({
    status: z.literal("committed"),
    operation_id: ApplyOperationIdSchema,
    draft_id: z.string().uuid(),
    record_revision: z.number().int().safe().positive(),
    draft_hash: StudioDigestSchema,
    resource_revisions: z.record(z.string(), StudioDigestSchema),
    files: z.array(StudioApplyFileRevisionSchema),
    diff: z.array(StudioApplyFileDiffSchema),
    committed_at: z.string().datetime({ offset: true }),
    idempotent_replay: z.boolean()
  })
  .strict();
export type StudioApplyResult = z.infer<typeof StudioApplyResultSchema>;

export const StudioApplyRequestSchema = z
  .object({
    plan_token: StudioApplyPlanTokenSchema,
    idempotency_key: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[\x21-\x7e]+$/)
  })
  .strict();
export type StudioApplyRequest = z.infer<typeof StudioApplyRequestSchema>;
