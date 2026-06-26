export type JsonSchemaLike = {
  readonly type?: string | readonly string[];
  readonly properties?: Record<string, JsonSchemaLike>;
  readonly items?: JsonSchemaLike;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchemaLike;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly oneOf?: readonly JsonSchemaLike[];
  readonly anyOf?: readonly JsonSchemaLike[];
  readonly allOf?: readonly JsonSchemaLike[];
  readonly not?: JsonSchemaLike;
  readonly description?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
};

export type PatternExpansionBoundary = {
  readonly type: "declaring_node_subgraph";
  readonly description?: string;
};

export type PatternRegistration = {
  readonly id: string;
  readonly declaring_node_type: "pattern";
  readonly input_schema: JsonSchemaLike;
  readonly output_schema: JsonSchemaLike;
  readonly expand: PatternExpansionBoundary;
  readonly local_context_roots?: readonly string[];
};
