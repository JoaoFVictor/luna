import type { JsonSchemaLike } from "./json-schema-types.js";
import type { StudioPresentable } from "./studio-presentation.js";
export type { JsonSchemaLike } from "./json-schema-types.js";

export type PatternExpansionBoundary = {
  readonly type: "declaring_node_subgraph";
  readonly description?: string;
};

export type PatternExecutionPolicy = {
  readonly batch_exclusion_keys?: readonly string[];
};

export type PatternRegistration = StudioPresentable & {
  readonly id: string;
  readonly declaring_node_type: "pattern";
  readonly input_schema: JsonSchemaLike;
  readonly output_schema: JsonSchemaLike;
  readonly expand: PatternExpansionBoundary;
  readonly execution_policy?: PatternExecutionPolicy;
  readonly local_context_roots?: readonly string[];
};
