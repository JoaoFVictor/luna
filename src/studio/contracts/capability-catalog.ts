import { z } from "zod";
import { CAPABILITY_SIDE_EFFECT_CATEGORIES } from "../../core/capabilities/manifest.js";
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

const StudioCapabilityReExportsSchema = z
  .object({
    built_ins: StringArraySchema,
    patterns: StringArraySchema,
    tools: StringArraySchema,
    gates: StringArraySchema,
    policies: StringArraySchema,
    ports: StringArraySchema,
    artifact_publishers: StringArraySchema
  })
  .strict();

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
    requires_repository: z.boolean(),
    deferred_lifecycle: z.literal("final_report").optional(),
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
    allowlist_required: z.boolean(),
    allowed_agent_modes: z
      .array(z.enum(["read_only", "trusted_local_write"]))
      .min(1)
      .max(2)
      .optional(),
    safety: z
      .object({
        local_writes: z.boolean(),
        network: z.boolean(),
        external_side_effects: z.boolean()
      })
      .strict()
      .optional()
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
    side_effect_category: z.enum(CAPABILITY_SIDE_EFFECT_CATEGORIES).optional(),
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
    workflow_node_types: z.array(z.literal("agent")).max(1),
    depends_on: StringArraySchema,
    presets: z.record(NonEmptyStringSchema, StringArraySchema),
    re_exports: StudioCapabilityReExportsSchema,
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

export const StudioCatalogConsumersSchema = z
  .object({
    workflows: StringArraySchema,
    agents: StringArraySchema
  })
  .strict();
export type StudioCatalogConsumers = z.infer<
  typeof StudioCatalogConsumersSchema
>;

export const StudioCapabilityConsumerIndexSchema = z
  .object({
    status: z.enum(["complete", "partial"]),
    incomplete_sources: z.array(z.enum(["workflows", "agents"])),
    capabilities: z.record(NonEmptyStringSchema, StudioCatalogConsumersSchema),
    registrations: z.record(NonEmptyStringSchema, StudioCatalogConsumersSchema)
  })
  .strict();
export type StudioCapabilityConsumerIndex = z.infer<
  typeof StudioCapabilityConsumerIndexSchema
>;

export const StudioCapabilityCatalogSchema = z
  .object({
    technical_fingerprint: StudioDigestSchema,
    presentation_fingerprint: StudioDigestSchema,
    capabilities: z.array(StudioCapabilitySummarySchema),
    registrations: z.array(StudioCapabilityRegistrationSchema),
    consumers: StudioCapabilityConsumerIndexSchema.optional()
  })
  .strict();
export type StudioCapabilityCatalog = z.infer<
  typeof StudioCapabilityCatalogSchema
>;
