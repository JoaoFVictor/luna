import { z } from "zod";
import {
  StudioPresentationSchema,
  type StudioPresentation
} from "../../core/capabilities/studio-presentation.js";
import { StudioDigestSchema } from "./digests.js";
import { StudioJsonValueSchema } from "./json.js";
import {
  StudioCatalogReferenceSchema,
  StudioHttpUrlSchema
} from "./catalog-references.js";

const NonEmptyStringSchema = z.string().min(1);
const StringArraySchema = z.array(NonEmptyStringSchema);

export const StudioRegistrationPresentationSchema = StudioPresentationSchema;
export type StudioRegistrationPresentation = StudioPresentation;

const StudioRegistrationOwnerSchema = z
  .object({
    capability_id: NonEmptyStringSchema,
    capability_version: NonEmptyStringSchema,
    capability_kind: z.enum(["execution", "composition"])
  })
  .strict();

const StudioRegistrationCommonShape = {
  id: NonEmptyStringSchema,
  owner: StudioRegistrationOwnerSchema,
  presentation: StudioRegistrationPresentationSchema
} as const;

const StudioBuiltInCatalogItemSchema = z
  .object({
    registration_kind: z.literal("built_in"),
    ...StudioRegistrationCommonShape,
    input_schema: StudioJsonValueSchema,
    output_schema: StudioJsonValueSchema,
    required_ports: StringArraySchema,
    side_effect_policy: NonEmptyStringSchema.optional()
  })
  .strict();

const StudioPatternCatalogItemSchema = z
  .object({
    registration_kind: z.literal("pattern"),
    ...StudioRegistrationCommonShape,
    declaring_node_type: z.literal("pattern"),
    input_schema: StudioJsonValueSchema,
    output_schema: StudioJsonValueSchema,
    expand: z
      .object({
        type: z.literal("declaring_node_subgraph"),
        description: NonEmptyStringSchema.optional()
      })
      .strict(),
    batch_exclusion_keys: StringArraySchema,
    local_context_roots: StringArraySchema
  })
  .strict();

const StudioToolCatalogItemSchema = z
  .object({
    registration_kind: z.literal("tool"),
    ...StudioRegistrationCommonShape,
    protocol: z.enum(["local", "mcp"]),
    input_schema: StudioJsonValueSchema,
    output_schema: StudioJsonValueSchema,
    runtime_requirements: StringArraySchema,
    materialization: z.enum(["local", "mcp", "runtime"]).optional(),
    allowlist_required: z.boolean()
  })
  .strict();

const StudioGateCatalogItemSchema = z
  .object({
    registration_kind: z.literal("gate"),
    ...StudioRegistrationCommonShape,
    input_schema: StudioJsonValueSchema,
    decision_schema: StudioJsonValueSchema,
    output_schema: StudioJsonValueSchema,
    repair_feedback_schema: StudioJsonValueSchema.optional(),
    local_context_roots: StringArraySchema,
    interrupt: z.enum(["required", "optional", "none"])
  })
  .strict();

const StudioPolicyCatalogItemSchema = z
  .object({
    registration_kind: z.literal("policy"),
    ...StudioRegistrationCommonShape,
    config_schema: StudioJsonValueSchema,
    local_context_roots: StringArraySchema,
    side_effect_semantics: z.enum(["none", "read", "write"]).optional(),
    side_effect_operation_ids: StringArraySchema,
    idempotency_scope: z
      .enum(["run", "node", "attempt", "external_resource"])
      .optional(),
    retry_semantics: z
      .enum(["replay_safe", "retry_requires_adoption", "retry_forbidden"])
      .optional(),
    error_codes: StringArraySchema
  })
  .strict();

const StudioPortCatalogItemSchema = z
  .object({
    registration_kind: z.literal("port"),
    ...StudioRegistrationCommonShape,
    capability: NonEmptyStringSchema,
    option_schema: StudioJsonValueSchema,
    lifecycle: z.array(z.enum(["validate", "open", "close"])),
    error_codes: StringArraySchema
  })
  .strict();

const StudioPublisherCatalogItemSchema = z
  .object({
    registration_kind: z.literal("artifact_publisher"),
    ...StudioRegistrationCommonShape,
    source_node_ownership: z.literal("declaring_node"),
    path_policy: z.enum(["declared_path", "capability_scoped"]),
    overwrite_policy: z.enum(["forbid", "replace", "version"]),
    config_schema: StudioJsonValueSchema.optional(),
    backend_requirements: StringArraySchema,
    manifest_transaction: z.literal("required")
  })
  .strict();

const StudioSchemaCatalogItemSchema = z
  .object({
    registration_kind: z.literal("schema"),
    ...StudioRegistrationCommonShape,
    schema: StudioJsonValueSchema
  })
  .strict();

export const StudioCapabilityRegistrationSchema = z.discriminatedUnion(
  "registration_kind",
  [
    StudioBuiltInCatalogItemSchema,
    StudioPatternCatalogItemSchema,
    StudioToolCatalogItemSchema,
    StudioGateCatalogItemSchema,
    StudioPolicyCatalogItemSchema,
    StudioPortCatalogItemSchema,
    StudioPublisherCatalogItemSchema,
    StudioSchemaCatalogItemSchema
  ]
);
export type StudioCapabilityRegistration = z.infer<
  typeof StudioCapabilityRegistrationSchema
>;

export const StudioCapabilitySummarySchema = z
  .object({
    id: NonEmptyStringSchema,
    version: NonEmptyStringSchema,
    kind: z.enum(["execution", "composition"]),
    depends_on: StringArraySchema,
    presentation: StudioRegistrationPresentationSchema,
    docs: z.array(
      z
        .object({
          title: NonEmptyStringSchema,
          path: StudioCatalogReferenceSchema.optional(),
          url: StudioHttpUrlSchema.optional()
        })
        .strict()
    )
  })
  .strict();
export type StudioCapabilitySummary = z.infer<
  typeof StudioCapabilitySummarySchema
>;

export const StudioCapabilityCatalogSchema = z
  .object({
    technical_fingerprint: StudioDigestSchema,
    presentation_fingerprint: StudioDigestSchema,
    capabilities: z.array(StudioCapabilitySummarySchema),
    registrations: z.array(StudioCapabilityRegistrationSchema)
  })
  .strict();
export type StudioCapabilityCatalog = z.infer<
  typeof StudioCapabilityCatalogSchema
>;
