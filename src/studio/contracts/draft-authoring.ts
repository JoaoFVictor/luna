import { z } from "zod";
import { StudioApplyRequestSchema } from "./apply.js";
import {
  StudioDraftListDiagnosticSchema,
  StudioDraftStatusSchema,
  StudioDraftSummarySchema
} from "./drafts.js";
import { StudioJsonValueSchema } from "./json.js";
import {
  StudioPathSchema,
  StudioResourceRefSchema
} from "./paths.js";
import { StudioDraftValidationResultSchema } from "./validation.js";

export const STUDIO_DRAFT_AUTHORING_LIMITS = Object.freeze({
  maxContentCharacters: 2 * 1024 * 1024,
  maxContentBytes: 2 * 1024 * 1024,
  maxPatchBytes: 8 * 1024 * 1024,
  maxEdits: 64,
  maxLayoutBytes: 512 * 1024,
  maxProjectionBytes: 8 * 1024 * 1024,
  maxListLimit: 100
});

const EditableResourceSchema = StudioResourceRefSchema.extend({
  kind: z.enum(["workflow", "agent"])
});

const StudioDraftExistingSourceSchema = z
  .object({ mode: z.literal("existing") })
  .strict();

const StudioDraftWorkflowBlankSourceSchema = z
  .object({ mode: z.literal("blank") })
  .strict();

const StudioDraftAgentBlankSourceSchema = z
  .object({
    mode: z.literal("blank"),
    model_profile: z.string().min(1).max(256)
  })
  .strict();

export const StudioDraftTemplateSelectionSchema = z
  .object({
    mode: z.literal("template"),
    template_id: z.string().min(1).max(128),
    template_version: z.string().min(1).max(32),
    parameters: z.record(StudioJsonValueSchema).optional()
  })
  .strict();
export type StudioDraftTemplateSelection = z.infer<
  typeof StudioDraftTemplateSelectionSchema
>;

export const StudioDraftCreateRequestSchema = z.union([
  z
    .object({
      resource: StudioResourceRefSchema.extend({ kind: z.literal("agent") }),
      source: z.discriminatedUnion("mode", [
        StudioDraftExistingSourceSchema,
        StudioDraftAgentBlankSourceSchema
      ])
    })
    .strict(),
  z
    .object({
      resource: StudioResourceRefSchema.extend({ kind: z.literal("workflow") }),
      source: z.discriminatedUnion("mode", [
        StudioDraftExistingSourceSchema,
        StudioDraftWorkflowBlankSourceSchema,
        StudioDraftTemplateSelectionSchema
      ])
    })
    .strict()
]);
export type StudioDraftCreateRequest = z.infer<
  typeof StudioDraftCreateRequestSchema
>;

export const StudioDraftTemplateAgentValueSchema = z
  .object({
    id: StudioResourceRefSchema.shape.id,
    output_schema: z.string().min(1).max(1024),
    mode: z.enum(["read_only", "trusted_local_write"]).optional()
  })
  .strict();
export type StudioDraftTemplateAgentValue = z.infer<
  typeof StudioDraftTemplateAgentValueSchema
>;

export const StudioDraftTemplateParameterSchema = z
  .object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(128),
    kind: z.enum(["agent"]),
    required: z.boolean(),
    allowed_modes: z
      .array(z.enum(["read_only", "trusted_local_write"]))
      .min(1)
      .max(2)
      .optional()
  })
  .strict();

const StudioDraftTemplateGeneratedFileSchema = z
  .object({
    relative_path: StudioPathSchema.shape.path,
    media_type: z.enum([
      "application/json",
      "application/yaml",
      "text/markdown",
      "text/plain"
    ]),
    role: z.enum(["definition", "schema", "asset"])
  })
  .strict();

const StudioDraftTemplateReusedResourceSchema = z
  .object({
    parameter_id: z.string().min(1).max(128),
    resource_kind: z.enum(["agent"]),
    behavior: z.literal("reuse")
  })
  .strict();

const StudioDraftTemplateSideEffectSchema = z
  .object({
    id: z.string().min(1).max(128),
    certainty: z.enum(["declared", "potential"]),
    semantics: z.enum(["read", "write", "unknown"]),
    description: z.string().min(1).max(512),
    operation_ids: z.array(z.string().min(1).max(256))
  })
  .strict();

const StudioDraftTemplateGraphNodeSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: z.enum(["built_in", "agent", "pattern", "human_gate"]),
    registration_id: z.string().min(1).max(256).optional(),
    registration_parameter: z.string().min(1).max(128).optional()
  })
  .strict()
  .refine(
    (node) =>
      (node.registration_id === undefined) !==
      (node.registration_parameter === undefined),
    { message: "A template graph node must declare one registration source" }
  );

const StudioDraftTemplateGraphPreviewSchema = z
  .object({
    nodes: z.array(StudioDraftTemplateGraphNodeSchema),
    edges: z.array(
      z
        .object({
          from: z.string().min(1).max(128),
          to: z.string().min(1).max(128)
        })
        .strict()
    )
  })
  .strict();

export const StudioDraftTemplateSchema = z
  .object({
    id: z.string().min(1).max(128),
    version: z.string().min(1).max(32),
    resource_kind: z.enum(["workflow", "agent"]),
    title: z.string().min(1).max(128),
    description: z.string().min(1).max(512),
    classification: z.enum(["production_pattern", "showcase"]),
    generated_files: z.array(StudioDraftTemplateGeneratedFileSchema),
    parameters: z.array(StudioDraftTemplateParameterSchema),
    reused_resources: z.array(StudioDraftTemplateReusedResourceSchema),
    capabilities: z.array(z.string().min(1).max(128)),
    config: z
      .object({
        required: z.boolean(),
        files: z.array(StudioPathSchema.shape.path)
      })
      .strict(),
    runtime_requirements: z.array(z.string().min(1).max(256)),
    provider_requirements: z.array(z.string().min(1).max(256)),
    side_effects: z.array(StudioDraftTemplateSideEffectSchema),
    graph_preview: StudioDraftTemplateGraphPreviewSchema
  })
  .strict();
export type StudioDraftTemplate = z.infer<typeof StudioDraftTemplateSchema>;

export const StudioDraftTemplateCatalogSchema = z
  .object({ templates: z.array(StudioDraftTemplateSchema) })
  .strict();
export type StudioDraftTemplateCatalog = z.infer<
  typeof StudioDraftTemplateCatalogSchema
>;

const StudioDraftWriteEditSchema = z
  .object({
    action: z.literal("write"),
    file: StudioPathSchema,
    content: z
      .string()
      .max(STUDIO_DRAFT_AUTHORING_LIMITS.maxContentCharacters)
  })
  .strict();

const StudioDraftDeleteEditSchema = z
  .object({
    action: z.literal("delete"),
    file: StudioPathSchema
  })
  .strict();

export const StudioDraftContentEditSchema = z.discriminatedUnion("action", [
  StudioDraftWriteEditSchema,
  StudioDraftDeleteEditSchema
]);
export type StudioDraftContentEdit = z.infer<
  typeof StudioDraftContentEditSchema
>;

export const StudioDraftPatchRequestSchema = z
  .object({
    edits: z
      .array(StudioDraftContentEditSchema)
      .min(1)
      .max(STUDIO_DRAFT_AUTHORING_LIMITS.maxEdits)
      .optional(),
    layout: StudioJsonValueSchema.optional()
  })
  .strict()
  .refine(
    (request) => request.edits !== undefined || request.layout !== undefined,
    { message: "A draft patch must include content edits or layout" }
  );
export type StudioDraftPatchRequest = z.infer<
  typeof StudioDraftPatchRequestSchema
>;

const StudioYamlPathSegmentSchema = z.union([
  z.string().min(1).max(256),
  z.number().int().safe().nonnegative()
]);

export const StudioYamlValuePathSchema = z
  .array(StudioYamlPathSegmentSchema)
  .min(1)
  .max(64);
export type StudioYamlValuePath = z.infer<typeof StudioYamlValuePathSchema>;

const StudioYamlSetOperationSchema = z
  .object({
    op: z.literal("set"),
    path: StudioYamlValuePathSchema,
    value: StudioJsonValueSchema
  })
  .strict();

const StudioYamlDeleteOperationSchema = z
  .object({
    op: z.literal("delete"),
    path: StudioYamlValuePathSchema
  })
  .strict();

const StudioYamlSequenceInsertOperationSchema = z
  .object({
    op: z.literal("sequence_insert"),
    path: StudioYamlValuePathSchema,
    index: z.number().int().safe().nonnegative().optional(),
    value: StudioJsonValueSchema
  })
  .strict();

const StudioYamlSequenceRemoveOperationSchema = z
  .object({
    op: z.literal("sequence_remove"),
    path: StudioYamlValuePathSchema,
    index: z.number().int().safe().nonnegative()
  })
  .strict();

export const StudioYamlSourceOperationSchema = z.discriminatedUnion("op", [
  StudioYamlSetOperationSchema,
  StudioYamlDeleteOperationSchema,
  StudioYamlSequenceInsertOperationSchema,
  StudioYamlSequenceRemoveOperationSchema
]);
export type StudioYamlSourceOperation = z.infer<
  typeof StudioYamlSourceOperationSchema
>;

export const StudioDraftSourceEditRequestSchema = z
  .object({
    file: StudioPathSchema,
    operations: z.array(StudioYamlSourceOperationSchema).min(1).max(64)
  })
  .strict();
export type StudioDraftSourceEditRequest = z.infer<
  typeof StudioDraftSourceEditRequestSchema
>;

export const StudioDraftSourceViewQuerySchema = z
  .object({
    root: StudioPathSchema.shape.root,
    path: StudioPathSchema.shape.path
  })
  .strict();
export type StudioDraftSourceViewQuery = z.infer<
  typeof StudioDraftSourceViewQuerySchema
>;

export const StudioDraftSourceViewSchema = z
  .object({
    file: StudioPathSchema,
    value: StudioJsonValueSchema
  })
  .strict();
export type StudioDraftSourceView = z.infer<
  typeof StudioDraftSourceViewSchema
>;

export const StudioDraftFileSchema = z
  .object({
    file: StudioPathSchema,
    media_type: z.enum([
      "application/json",
      "application/yaml",
      "text/markdown",
      "text/plain"
    ]),
    state: z.enum(["present", "deleted"]),
    content: z.string().optional()
  })
  .strict()
  .superRefine((file, context) => {
    if ((file.state === "present") !== (file.content !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Present draft files must contain content and deleted files must not"
      });
    }
  });
export type StudioDraftFile = z.infer<typeof StudioDraftFileSchema>;

export const StudioDraftItemSchema = z
  .object({
    draft_id: z.string().uuid(),
    record_revision: z.number().int().safe().positive(),
    content_revision: z.number().int().safe().positive(),
    layout_revision: z.number().int().safe().nonnegative(),
    primary_resource: EditableResourceSchema,
    status: StudioDraftStatusSchema,
    draft_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    etag: z.string().min(1).max(512),
    files: z.array(StudioDraftFileSchema),
    layout: StudioJsonValueSchema.optional(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true })
  })
  .strict();
export type StudioDraftItem = z.infer<typeof StudioDraftItemSchema>;

export const StudioDraftListItemSchema = StudioDraftSummarySchema.extend({
  primary_resource: EditableResourceSchema,
  etag: z.string().min(1).max(512)
}).strict();
export type StudioDraftListItem = z.infer<
  typeof StudioDraftListItemSchema
>;

export const StudioDraftAuthoringListPageSchema = z
  .object({
    items: z.array(StudioDraftListItemSchema),
    diagnostics: z.array(StudioDraftListDiagnosticSchema),
    next_cursor: z.string().min(1).nullable()
  })
  .strict();
export type StudioDraftAuthoringListPage = z.infer<
  typeof StudioDraftAuthoringListPageSchema
>;

export const StudioDraftListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(STUDIO_DRAFT_AUTHORING_LIMITS.maxListLimit)
      .optional()
  })
  .strict();
export type StudioDraftListQuery = z.infer<
  typeof StudioDraftListQuerySchema
>;

export const StudioDraftParamsSchema = z
  .object({ draftId: z.string().uuid() })
  .strict();
export type StudioDraftParams = z.infer<typeof StudioDraftParamsSchema>;

export const StudioDraftEmptyCommandSchema = z.object({}).strict();

export const StudioDraftValidationResponseSchema = z
  .object({
    draft: StudioDraftItemSchema,
    validation: StudioDraftValidationResultSchema
  })
  .strict();
export type StudioDraftValidationResponse = z.infer<
  typeof StudioDraftValidationResponseSchema
>;

export const StudioDraftApplyRequestBodySchema = StudioApplyRequestSchema;
