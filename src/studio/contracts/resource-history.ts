import { z } from "zod";
import { StudioApplyFileDiffSchema } from "./apply.js";
import { StudioDraftItemSchema } from "./draft-authoring.js";
import { StudioResourceRefSchema } from "./paths.js";

export const STUDIO_RESOURCE_HISTORY_LIMITS = Object.freeze({
  defaultRevisions: 25,
  maxRevisions: 50,
  maxSubjectCharacters: 240,
  maxComparedFiles: 128,
  maxSnapshotFiles: 128,
  maxSnapshotFileBytes: 2 * 1024 * 1024,
  maxSnapshotBytes: 8 * 1024 * 1024
});

export const StudioHistoryResourceSchema = StudioResourceRefSchema.extend({
  kind: z.enum(["workflow", "agent"])
}).strict();
export type StudioHistoryResource = z.infer<
  typeof StudioHistoryResourceSchema
>;

/**
 * A full object id is data, not a Git revision expression. SHA-1 and SHA-256
 * repositories are both supported; abbreviated ids and revspec operators are
 * deliberately rejected.
 */
export const StudioGitRevisionIdSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export type StudioGitRevisionId = z.infer<typeof StudioGitRevisionIdSchema>;

const SafeCommitSubjectSchema = z
  .string()
  .max(STUDIO_RESOURCE_HISTORY_LIMITS.maxSubjectCharacters)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "Commit subjects must not contain control characters"
  });

export const StudioResourceHistoryRevisionSchema = z
  .object({
    revision_id: StudioGitRevisionIdSchema,
    committed_at: z.string().datetime({ offset: true }),
    subject: SafeCommitSubjectSchema
  })
  .strict();
export type StudioResourceHistoryRevision = z.infer<
  typeof StudioResourceHistoryRevisionSchema
>;

export const StudioResourceHistoryListQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(STUDIO_RESOURCE_HISTORY_LIMITS.maxRevisions)
      .default(STUDIO_RESOURCE_HISTORY_LIMITS.defaultRevisions)
  })
  .strict();
export type StudioResourceHistoryListQuery = z.infer<
  typeof StudioResourceHistoryListQuerySchema
>;

export const StudioResourceHistoryResponseSchema = z
  .object({
    resource: StudioHistoryResourceSchema,
    revisions: z
      .array(StudioResourceHistoryRevisionSchema)
      .max(STUDIO_RESOURCE_HISTORY_LIMITS.maxRevisions),
    truncated: z.boolean()
  })
  .strict();
export type StudioResourceHistoryResponse = z.infer<
  typeof StudioResourceHistoryResponseSchema
>;

export const StudioResourceHistoryCompareRequestSchema = z
  .object({
    base_revision_id: StudioGitRevisionIdSchema,
    target_revision_id: StudioGitRevisionIdSchema
  })
  .strict();
export type StudioResourceHistoryCompareRequest = z.infer<
  typeof StudioResourceHistoryCompareRequestSchema
>;

export const StudioResourceHistoryCompareResponseSchema = z
  .object({
    resource: StudioHistoryResourceSchema,
    base_revision_id: StudioGitRevisionIdSchema,
    target_revision_id: StudioGitRevisionIdSchema,
    diff: z
      .array(StudioApplyFileDiffSchema)
      .max(STUDIO_RESOURCE_HISTORY_LIMITS.maxComparedFiles)
  })
  .strict();
export type StudioResourceHistoryCompareResponse = z.infer<
  typeof StudioResourceHistoryCompareResponseSchema
>;

export const StudioResourceHistoryRestoreRequestSchema = z
  .object({
    revision_id: StudioGitRevisionIdSchema,
    confirm_restore_as_new_draft: z.literal(true)
  })
  .strict();
export type StudioResourceHistoryRestoreRequest = z.infer<
  typeof StudioResourceHistoryRestoreRequestSchema
>;

export const StudioResourceHistoryRestoreResponseSchema = z
  .object({
    resource: StudioHistoryResourceSchema,
    revision_id: StudioGitRevisionIdSchema,
    draft: StudioDraftItemSchema
  })
  .strict();
export type StudioResourceHistoryRestoreResponse = z.infer<
  typeof StudioResourceHistoryRestoreResponseSchema
>;

export const StudioResourceHistoryParamsSchema = z
  .object({
    kind: StudioHistoryResourceSchema.shape.kind,
    id: StudioHistoryResourceSchema.shape.id
  })
  .strict();
