import { z } from "zod";
import { StudioJsonValueSchema } from "./json.js";
import { StudioDigestSchema } from "./digests.js";
import {
  StudioPathSchema,
  StudioResourceRefSchema
} from "./paths.js";

export const StudioDraftStatusSchema = z.enum([
  "dirty",
  "invalid",
  "valid",
  "conflicted"
]);

export const StudioBaseFileSchema = z
  .object({
    file: StudioPathSchema,
    sha256: StudioDigestSchema.nullable(),
    content_ref: StudioDigestSchema.nullable()
  })
  .strict()
  .superRefine((file, context) => {
    if ((file.sha256 === null) !== (file.content_ref === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Base file hash and content reference must both be present or absent"
      });
    }
  });
export type StudioBaseFile = z.infer<typeof StudioBaseFileSchema>;

export const StudioDependencySchema = z
  .object({
    file: StudioPathSchema,
    sha256: StudioDigestSchema
  })
  .strict();
export type StudioDependency = z.infer<typeof StudioDependencySchema>;

const StudioWriteChangeSchema = z
  .object({
    action: z.literal("write"),
    file: StudioPathSchema,
    base_sha256: StudioDigestSchema.nullable(),
    content_sha256: StudioDigestSchema,
    content_ref: StudioDigestSchema,
    eol: z.enum(["lf", "crlf"]).optional(),
    mode: z.number().int().min(0).max(0o777).optional()
  })
  .strict()
  .superRefine((change, context) => {
    if (change.content_sha256 !== change.content_ref) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Content reference must match the content hash",
        path: ["content_ref"]
      });
    }
  });

const StudioDeleteChangeSchema = z
  .object({
    action: z.literal("delete"),
    file: StudioPathSchema,
    base_sha256: StudioDigestSchema
  })
  .strict();

export const StudioDraftFileChangeSchema = z.union([
  StudioWriteChangeSchema,
  StudioDeleteChangeSchema
]);
export type StudioDraftFileChange = z.infer<
  typeof StudioDraftFileChangeSchema
>;

export const StudioChangeSetSchema = z
  .object({
    format_version: z.literal(1),
    draft_id: z.string().uuid(),
    record_revision: z.number().int().safe().positive(),
    content_revision: z.number().int().safe().positive(),
    layout_revision: z.number().int().safe().nonnegative(),
    primary_resource: StudioResourceRefSchema,
    resources: z.array(StudioResourceRefSchema).min(1),
    resource_revisions: z.record(z.string(), StudioDigestSchema.nullable()),
    base_bundle_hash: StudioDigestSchema.nullable(),
    draft_hash: StudioDigestSchema,
    technical_catalog_fingerprint: StudioDigestSchema,
    presentation_catalog_fingerprint: StudioDigestSchema,
    base_files: z.array(StudioBaseFileSchema),
    dependencies: z.array(StudioDependencySchema),
    allowed_files: z.array(StudioPathSchema),
    changes: z.array(StudioDraftFileChangeSchema),
    layout: StudioJsonValueSchema.optional(),
    status: StudioDraftStatusSchema,
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true })
  })
  .strict();
export type StudioChangeSet = z.infer<typeof StudioChangeSetSchema>;

export const StudioDraftSummarySchema = StudioChangeSetSchema.pick({
  draft_id: true,
  record_revision: true,
  content_revision: true,
  layout_revision: true,
  primary_resource: true,
  draft_hash: true,
  status: true,
  updated_at: true
});
export type StudioDraftSummary = z.infer<typeof StudioDraftSummarySchema>;

export const StudioDraftListDiagnosticSchema = z
  .object({
    draft_id: z.string().uuid().nullable(),
    code: z.enum([
      "studio_draft_corrupt",
      "studio_storage_invalid",
      "studio_draft_too_large",
      "studio_storage_io_failed"
    ]),
    message: z.string().min(1)
  })
  .strict();
export type StudioDraftListDiagnostic = z.infer<
  typeof StudioDraftListDiagnosticSchema
>;

export const StudioDraftListPageSchema = z
  .object({
    items: z.array(StudioDraftSummarySchema),
    diagnostics: z.array(StudioDraftListDiagnosticSchema),
    next_cursor: z.string().min(1).nullable()
  })
  .strict();
export type StudioDraftListPage = z.infer<typeof StudioDraftListPageSchema>;
