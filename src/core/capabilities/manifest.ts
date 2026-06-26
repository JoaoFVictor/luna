import type { JsonSchemaLike, PatternRegistration } from "./pattern-registration.js";

export type CapabilityKind = "execution" | "composition";

export type CapabilityDoc = {
  readonly title: string;
  readonly path?: string;
  readonly url?: string;
};

export type SchemaRegistration = {
  readonly id: string;
  readonly schema: JsonSchemaLike;
};

export type BuiltInRegistration = {
  readonly id: string;
  readonly input_schema: JsonSchemaLike;
  readonly output_schema: JsonSchemaLike;
  readonly required_ports?: readonly string[];
  readonly side_effect_policy?: string;
};

export type ToolRegistration = {
  readonly id: string;
  readonly protocol: "local" | "mcp";
  readonly input_schema: JsonSchemaLike;
  readonly output_schema: JsonSchemaLike;
  readonly runtime_requirements?: readonly string[];
  readonly materialization?: "local" | "mcp" | "runtime";
  readonly allowlist_required?: boolean;
};

export type GateRegistration = {
  readonly id: string;
  readonly input_schema: JsonSchemaLike;
  readonly decision_schema: JsonSchemaLike;
  readonly output_schema: JsonSchemaLike;
  readonly local_context_roots?: readonly string[];
  readonly interrupt: "required" | "optional" | "none";
  readonly repair_feedback_schema?: JsonSchemaLike;
};

export type PolicyRegistration = {
  readonly id: string;
  readonly config_schema: JsonSchemaLike;
  readonly local_context_roots?: readonly string[];
  readonly side_effect_semantics?: "none" | "read" | "write";
  readonly retry_semantics?: "replay_safe" | "retry_requires_adoption" | "retry_forbidden";
  readonly error_codes?: readonly string[];
};

export type PortRegistration = {
  readonly id: string;
  readonly capability: string;
  readonly option_schema: JsonSchemaLike;
  readonly lifecycle?: readonly ("validate" | "open" | "close")[];
  readonly error_codes?: readonly string[];
};

export type ArtifactPublisherRegistration = {
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

export type CapabilityManifest = {
  readonly id: string;
  readonly kind: CapabilityKind;
  readonly version: string;
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
