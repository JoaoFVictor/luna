import { z } from "zod";
import { StudioApplyConflictSchema } from "./apply.js";
import { StudioDigestSchema } from "./digests.js";
import { StudioJsonValueSchema } from "./json.js";
import { StudioPathSchema } from "./paths.js";

export const STUDIO_CONFIGURATION_LIMITS = Object.freeze({
  maxFields: 512,
  maxPathDepth: 32,
  maxPathSegmentLength: 128,
  maxUpdates: 128,
  maxDiagnostics: 128,
  maxReferences: 256
});

const ConfigurationIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);

export const StudioRepositoryRemoteNameSchema = ConfigurationIdentifierSchema;

const StudioRepositoryRemoteSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("name"),
      name: StudioRepositoryRemoteNameSchema
    })
    .strict(),
  z.object({ kind: z.literal("redacted") }).strict()
]);

export const StudioConfigurationFieldPathSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(STUDIO_CONFIGURATION_LIMITS.maxPathSegmentLength)
  )
  .min(1)
  .max(STUDIO_CONFIGURATION_LIMITS.maxPathDepth);
export type StudioConfigurationFieldPath = z.infer<
  typeof StudioConfigurationFieldPathSchema
>;

export const StudioConfigurationValueTypeSchema = z.enum([
  "boolean",
  "integer",
  "number",
  "string",
  "boolean_array",
  "integer_array",
  "number_array",
  "string_array"
]);
export type StudioConfigurationValueType = z.infer<
  typeof StudioConfigurationValueTypeSchema
>;

export function studioConfigurationValueMatchesType(
  type: StudioConfigurationValueType,
  value: unknown
): boolean {
  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean_array":
      return Array.isArray(value) &&
        value.every((item) => typeof item === "boolean");
    case "integer_array":
      return Array.isArray(value) && value.every(Number.isSafeInteger);
    case "number_array":
      return Array.isArray(value) && value.every(Number.isFinite);
    case "string_array":
      return Array.isArray(value) &&
        value.every((item) => typeof item === "string");
  }
}

const ConfigurationScalarSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.string()
]);

export const StudioConfigurationFieldSchema = z
  .object({
    path: StudioConfigurationFieldPathSchema,
    expression: z.string().min(3).max(2_048),
    value_type: StudioConfigurationValueTypeSchema,
    exposure: z.enum(["editable", "read_only"]),
    required: z.boolean(),
    present: z.boolean(),
    value: StudioJsonValueSchema.optional(),
    title: z.string().min(1).max(256).optional(),
    description: z.string().min(1).max(2_000).optional(),
    enum_values: z.array(ConfigurationScalarSchema).min(1).max(256).optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    min_length: z.number().int().safe().nonnegative().optional(),
    max_length: z.number().int().safe().nonnegative().optional(),
    min_items: z.number().int().safe().nonnegative().optional(),
    max_items: z.number().int().safe().nonnegative().optional()
  })
  .strict()
  .superRefine((field, context) => {
    if (field.present !== (field.value !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A present configuration field must include its value",
        path: ["value"]
      });
    }
    if (
      field.value !== undefined &&
      !studioConfigurationValueMatchesType(field.value_type, field.value)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A configuration field value must match its declared value type",
        path: ["value"]
      });
    }
    if (
      field.enum_values !== undefined &&
      (field.value_type.endsWith("_array") ||
        field.enum_values.some(
          (value) =>
            !studioConfigurationValueMatchesType(field.value_type, value)
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Configuration enum values must match the scalar field type",
        path: ["enum_values"]
      });
    }
    if (
      field.enum_values !== undefined &&
      new Set(field.enum_values).size !== field.enum_values.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Configuration enum values must be unique",
        path: ["enum_values"]
      });
    }
    if (
      field.value !== undefined &&
      field.enum_values !== undefined &&
      !field.enum_values.some((candidate) => candidate === field.value)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A configuration field value must belong to its enum",
        path: ["value"]
      });
    }
  });
export type StudioConfigurationField = z.infer<
  typeof StudioConfigurationFieldSchema
>;

export const StudioConfigurationDiagnosticSchema = z
  .object({
    severity: z.enum(["warning", "error"]),
    code: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/),
    message: z.string().min(1).max(2_000),
    field_path: StudioConfigurationFieldPathSchema.optional()
  })
  .strict();
export type StudioConfigurationDiagnostic = z.infer<
  typeof StudioConfigurationDiagnosticSchema
>;

const StudioConfigurationSchemaSummarySchema = z
  .object({
    total_leaf_count: z.number().int().safe().nonnegative(),
    classified_field_count: z.number().int().safe().nonnegative(),
    unclassified_field_count: z.number().int().safe().nonnegative(),
    unsupported_classified_field_count: z.number().int().safe().nonnegative()
  })
  .strict();

const StudioConfigurationReferenceSchema = z
  .object({
    expression: z.string().min(1).max(2_048)
  })
  .strict();

export const StudioWorkflowConfigurationSchema = z
  .object({
    workflow_id: ConfigurationIdentifierSchema,
    status: z.enum(["not_declared", "unavailable", "invalid", "ready"]),
    declared: z.boolean(),
    config_present: z.boolean(),
    schema_present: z.boolean(),
    raw_yaml_enabled: z.literal(false),
    file_reference: z.string().min(1).max(1_024).optional(),
    schema_reference: z.string().min(1).max(1_024).optional(),
    installed_revision: StudioDigestSchema.optional(),
    schema_summary: StudioConfigurationSchemaSummarySchema,
    fields: z
      .array(StudioConfigurationFieldSchema)
      .max(STUDIO_CONFIGURATION_LIMITS.maxFields),
    references: z
      .array(StudioConfigurationReferenceSchema)
      .max(STUDIO_CONFIGURATION_LIMITS.maxReferences),
    diagnostics: z
      .array(StudioConfigurationDiagnosticSchema)
      .max(STUDIO_CONFIGURATION_LIMITS.maxDiagnostics)
  })
  .strict();
export type StudioWorkflowConfiguration = z.infer<
  typeof StudioWorkflowConfigurationSchema
>;

export const StudioConfigurationDraftSchema = z
  .object({
    draft_id: z.string().uuid(),
    record_revision: z.number().int().safe().positive(),
    content_revision: z.number().int().safe().positive(),
    status: z.enum(["dirty", "invalid", "valid", "conflicted"]),
    draft_hash: StudioDigestSchema,
    etag: z.string().min(1).max(512),
    configuration: StudioWorkflowConfigurationSchema,
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true })
  })
  .strict();
export type StudioConfigurationDraft = z.infer<
  typeof StudioConfigurationDraftSchema
>;

export const StudioConfigurationUpdateSchema = z
  .object({
    path: StudioConfigurationFieldPathSchema,
    value: StudioJsonValueSchema
  })
  .strict();

export const StudioConfigurationPatchRequestSchema = z
  .object({
    updates: z
      .array(StudioConfigurationUpdateSchema)
      .min(1)
      .max(STUDIO_CONFIGURATION_LIMITS.maxUpdates)
  })
  .strict()
  .superRefine((request, context) => {
    const seen = new Set<string>();
    request.updates.forEach((update, index) => {
      const key = JSON.stringify(update.path);
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A configuration patch cannot update the same field twice",
          path: ["updates", index, "path"]
        });
      }
      seen.add(key);
    });
  });
export type StudioConfigurationPatchRequest = z.infer<
  typeof StudioConfigurationPatchRequestSchema
>;

export const StudioConfigurationValidationSchema = z
  .object({
    status: z.enum(["valid", "invalid"]),
    diagnostics: z
      .array(StudioConfigurationDiagnosticSchema)
      .max(STUDIO_CONFIGURATION_LIMITS.maxDiagnostics),
    validated_at: z.string().datetime({ offset: true })
  })
  .strict();

export const StudioConfigurationValidationResponseSchema = z
  .object({
    draft: StudioConfigurationDraftSchema,
    validation: StudioConfigurationValidationSchema
  })
  .strict();
export type StudioConfigurationValidationResponse = z.infer<
  typeof StudioConfigurationValidationResponseSchema
>;

export const StudioConfigurationValueDiffSchema = z
  .object({
    path: StudioConfigurationFieldPathSchema,
    before_present: z.boolean(),
    before: StudioJsonValueSchema.optional(),
    after_present: z.boolean(),
    after: StudioJsonValueSchema.optional()
  })
  .strict()
  .superRefine((change, context) => {
    if (
      change.before_present !== (change.before !== undefined) ||
      change.after_present !== (change.after !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Configuration diff presence must match its projected values"
      });
    }
  });
export type StudioConfigurationValueDiff = z.infer<
  typeof StudioConfigurationValueDiffSchema
>;

const StudioConfigurationApplyPlanBaseSchema = z
  .object({
    draft_id: z.string().uuid(),
    record_revision: z.number().int().safe().positive(),
    content_revision: z.number().int().safe().positive(),
    draft_hash: StudioDigestSchema,
    changes: z.array(StudioConfigurationValueDiffSchema),
    conflicts: z.array(StudioApplyConflictSchema)
  })
  .strict();

const StudioConfigurationReadyApplyPlanSchema =
  StudioConfigurationApplyPlanBaseSchema.extend({
    status: z.literal("ready"),
    conflicts: z.array(StudioApplyConflictSchema).length(0),
    plan_token: z.string().min(32).max(256),
    expires_at: z.string().datetime({ offset: true })
  }).strict();

const StudioConfigurationConflictedApplyPlanSchema =
  StudioConfigurationApplyPlanBaseSchema.extend({
    status: z.literal("conflicted"),
    conflicts: z.array(StudioApplyConflictSchema).min(1)
  }).strict();

export const StudioConfigurationApplyPlanSchema = z.discriminatedUnion(
  "status",
  [
    StudioConfigurationReadyApplyPlanSchema,
    StudioConfigurationConflictedApplyPlanSchema
  ]
);
export type StudioConfigurationApplyPlan = z.infer<
  typeof StudioConfigurationApplyPlanSchema
>;

export const StudioConfigurationApplyRequestSchema = z
  .object({
    plan_token: z.string().min(32).max(256),
    idempotency_key: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[\x21-\x7e]+$/)
  })
  .strict();

export const StudioConfigurationApplyResultSchema = z
  .object({
    status: z.literal("committed"),
    operation_id: z.string().uuid(),
    draft_id: z.string().uuid(),
    record_revision: z.number().int().safe().positive(),
    draft_hash: StudioDigestSchema,
    resource_revisions: z.record(z.string(), StudioDigestSchema),
    files: z.array(
      z
        .object({
          file: StudioPathSchema,
          sha256: StudioDigestSchema.nullable()
        })
        .strict()
    ),
    committed_at: z.string().datetime({ offset: true }),
    idempotent_replay: z.boolean()
  })
  .strict();
export type StudioConfigurationApplyResult = z.infer<
  typeof StudioConfigurationApplyResultSchema
>;

export const StudioConfigurationWorkflowParamsSchema = z
  .object({ workflowId: ConfigurationIdentifierSchema })
  .strict();

export const StudioConfigurationDraftParamsSchema =
  StudioConfigurationWorkflowParamsSchema.extend({
    draftId: z.string().uuid()
  }).strict();

export const StudioConfigurationEmptyCommandSchema = z.object({}).strict();

const ModelSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("literal"), model: z.string().min(1).max(512) })
    .strict(),
  z
    .object({
      kind: z.literal("environment"),
      variable: z.string().min(1).max(256),
      present: z.boolean(),
      fallback_model: z.string().min(1).max(512).optional()
    })
    .strict()
]);

export const StudioModelConfigurationSchema = z
  .object({
    editing: z.literal("read_only"),
    profiles: z.array(
      z
        .object({
          id: z.string().min(1).max(256),
          source: ModelSourceSchema,
          reasoning_effort: z.enum(["low", "medium", "high", "xhigh"]),
          transport: z.enum(["auto", "sse", "websocket"]),
          consumers: z.array(z.string().min(1).max(256))
        })
        .strict()
    ),
    diagnostics: z.array(StudioConfigurationDiagnosticSchema)
  })
  .strict();
export type StudioModelConfiguration = z.infer<
  typeof StudioModelConfigurationSchema
>;

export const StudioRepositoryConfigurationSchema = z
  .object({
    editing: z.literal("read_only"),
    confinement_policy: z.literal("not_configured"),
    repositories: z.array(
      z
        .object({
          id: z.string().min(1).max(256),
          provider: z.string().min(1).max(256),
          owner: z.string().min(1).max(256),
          name: z.string().min(1).max(256),
          path_display: z.string().min(1).max(1_024),
          path_kind: z.enum(["absolute_redacted", "relative"]),
          remote: StudioRepositoryRemoteSchema,
          expected_remote_count: z.number().int().safe().nonnegative(),
          skills: z.array(z.string().min(1).max(256)),
          availability: z.enum(["available", "unavailable", "not_checked"]),
          trusted_write_readiness: z.literal("not_assessed"),
          required_by: z.array(z.string().min(1).max(256))
        })
        .strict()
    ),
    diagnostics: z.array(StudioConfigurationDiagnosticSchema)
  })
  .strict();
export type StudioRepositoryConfiguration = z.infer<
  typeof StudioRepositoryConfigurationSchema
>;

const StudioProviderProbeEffectSchema = z.enum([
  "credential_read",
  "network_read",
  "process_execution"
]);

export const StudioProviderConfigurationSchema = z
  .object({
    editing: z.literal("read_only"),
    providers: z.array(
      z
        .object({
          id: z.string().min(1).max(256),
          adapter_ids: z.array(z.string().min(1).max(256)),
          credential_status: z.enum(["not_checked", "healthy"]),
          probe: z.object({
            id: z.string().min(1).max(256),
            effects: z.array(StudioProviderProbeEffectSchema).min(1),
            timeout_ms: z.number().int().safe().positive()
          }).strict().optional(),
          checked_at: z.string().datetime({ offset: true }).optional(),
          checked_probe_id: z.string().min(1).max(256).optional()
        })
        .strict()
        .superRefine((provider, context) => {
          const verified = provider.credential_status === "healthy";
          if (verified !== (
            provider.checked_at !== undefined &&
            provider.checked_probe_id !== undefined
          )) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Healthy providers require exact probe evidence"
            });
          }
        })
    )
  })
  .strict();
export type StudioProviderConfiguration = z.infer<
  typeof StudioProviderConfigurationSchema
>;

export const StudioProviderProbeParamsSchema = z.object({
  providerId: z.string().min(1).max(256)
}).strict();

export const StudioProviderProbeResultSchema = z.discriminatedUnion("status", [
  z.object({
    provider_id: z.string().min(1).max(256),
    probe_id: z.string().min(1).max(256),
    status: z.literal("healthy"),
    checked_at: z.string().datetime({ offset: true }),
    effects: z.array(StudioProviderProbeEffectSchema).min(1),
    timeout_ms: z.number().int().safe().positive(),
    summary: z.string().min(1).max(512)
  }).strict(),
  z.object({
    provider_id: z.string().min(1).max(256),
    probe_id: z.string().min(1).max(256),
    status: z.literal("unhealthy"),
    effects: z.array(StudioProviderProbeEffectSchema).min(1),
    timeout_ms: z.number().int().safe().positive(),
    summary: z.string().min(1).max(512)
  }).strict(),
  z.object({
    provider_id: z.string().min(1).max(256),
    status: z.literal("unsupported"),
    summary: z.string().min(1).max(512)
  }).strict()
]);
export type StudioProviderProbeResult = z.infer<typeof StudioProviderProbeResultSchema>;

export const StudioRuntimeConfigurationSchema = z
  .object({
    editing: z.literal("read_only"),
    workflow_runtime_id: z.string().min(1).max(256),
    agent_runtime_id: z.string().min(1).max(256),
    workspace_strategy: z.string().min(1).max(256),
    plugin_count: z.number().int().safe().nonnegative(),
    option_values_redacted: z.literal(true)
  })
  .strict();
export type StudioRuntimeConfiguration = z.infer<
  typeof StudioRuntimeConfigurationSchema
>;
