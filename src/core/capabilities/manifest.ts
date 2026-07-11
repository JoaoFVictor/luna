import type { JsonSchemaLike } from "./json-schema-types.js";
import type { PatternRegistration } from "./pattern-registration.js";
import type { StudioPresentable } from "./studio-presentation.js";
import type { LunaToolMode, LunaToolSafety } from "../tools/contracts.js";

export type CapabilityKind = "execution" | "composition";

export const CAPABILITY_SIDE_EFFECT_CATEGORIES = [
  "repository_write",
  "external_write",
  "model_call",
  "provider_read",
  "local_process",
  "runtime_bookkeeping",
  "other"
] as const;
export type CapabilitySideEffectCategory =
  typeof CAPABILITY_SIDE_EFFECT_CATEGORIES[number];

/**
 * Workflow node types whose execution authority is supplied by a capability
 * without a registration selected directly on the node.
 *
 * Registered node kinds (built-ins, patterns, and gates) derive their owner
 * from the selected registration. Agent nodes select an agent definition, so
 * their owning execution capability must be declared explicitly instead.
 */
export type CapabilityWorkflowNodeType = "agent";

export type CapabilityDoc = {
  readonly title: string;
  readonly path?: string;
  readonly url?: string;
};

export type SchemaRegistration = StudioPresentable & {
  readonly id: string;
  readonly schema: JsonSchemaLike;
};

export type BuiltInRegistration = StudioPresentable & {
  readonly id: string;
  readonly input_schema: JsonSchemaLike;
  readonly output_schema: JsonSchemaLike;
  readonly required_ports?: readonly string[];
  readonly side_effect_policy?: string;
};

export type ToolRegistration = StudioPresentable & {
  readonly id: string;
  readonly protocol: "local" | "mcp";
  readonly input_schema: JsonSchemaLike;
  readonly output_schema: JsonSchemaLike;
  readonly runtime_requirements?: readonly string[];
  readonly materialization?: "local" | "mcp" | "runtime";
  readonly allowlist_required?: boolean;
  readonly allowed_agent_modes?: readonly LunaToolMode[];
  readonly safety?: LunaToolSafety;
};

export type GateRegistration = StudioPresentable & {
  readonly id: string;
  readonly input_schema: JsonSchemaLike;
  readonly decision_schema: JsonSchemaLike;
  readonly output_schema: JsonSchemaLike;
  readonly local_context_roots?: readonly string[];
  readonly interrupt: "required" | "optional" | "none";
  readonly repair_feedback_schema?: JsonSchemaLike;
};

export type PolicyRegistration = StudioPresentable & {
  readonly id: string;
  readonly config_schema: JsonSchemaLike;
  readonly local_context_roots?: readonly string[];
  readonly side_effect_semantics?: "none" | "read" | "write";
  readonly side_effect_category?: CapabilitySideEffectCategory;
  readonly side_effect_operation_ids?: readonly string[];
  readonly idempotency_scope?: "run" | "node" | "attempt" | "external_resource";
  readonly retry_semantics?: "replay_safe" | "retry_requires_adoption" | "retry_forbidden";
  readonly error_codes?: readonly string[];
};

export type PortRegistration = StudioPresentable & {
  readonly id: string;
  readonly capability: string;
  readonly option_schema: JsonSchemaLike;
  readonly lifecycle?: readonly ("validate" | "open" | "close")[];
  readonly error_codes?: readonly string[];
};

export type ArtifactPublisherRegistration = StudioPresentable & {
  readonly id: string;
  readonly source_node_ownership: "declaring_node";
  readonly path_policy: "declared_path" | "capability_scoped";
  readonly overwrite_policy: "forbid" | "replace" | "version";
  readonly config_schema?: JsonSchemaLike;
  readonly backend_requirements?: readonly string[];
  readonly manifest_transaction: "required";
};

export type CapabilityReExports = {
  readonly built_ins?: readonly string[];
  readonly patterns?: readonly string[];
  readonly tools?: readonly string[];
  readonly gates?: readonly string[];
  readonly policies?: readonly string[];
  readonly ports?: readonly string[];
  readonly artifact_publishers?: readonly string[];
};

export type CapabilityManifest = StudioPresentable & {
  readonly id: string;
  readonly kind: CapabilityKind;
  readonly version: string;
  readonly workflow_node_types?: readonly CapabilityWorkflowNodeType[];
  readonly depends_on?: readonly string[];
  readonly patterns?: Record<string, PatternRegistration>;
  readonly built_ins?: Record<string, BuiltInRegistration>;
  readonly tools?: Record<string, ToolRegistration>;
  readonly gates?: Record<string, GateRegistration>;
  readonly policies?: Record<string, PolicyRegistration>;
  readonly schemas?: Record<string, SchemaRegistration>;
  readonly ports?: Record<string, PortRegistration>;
  readonly artifact_publishers?: Record<string, ArtifactPublisherRegistration>;
  readonly presets?: Record<string, readonly string[]>;
  readonly docs?: readonly CapabilityDoc[];
  readonly re_exports?: CapabilityReExports;
};

export function capabilityManifest<const T extends CapabilityManifest>(
  manifest: T
): T {
  return manifest;
}
