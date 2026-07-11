import { isPlainObject, type JsonValue } from "../../../core/json/value.js";
import type { JsonSchemaLike } from "../../../core/capabilities/json-schema-types.js";
import type { StudioSchemaDiagnostic } from "../../contracts/schema-validation.js";
import { appendStudioSchemaPointer } from "./schema-pointers.js";

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string"
]);
const RUNTIME_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "number",
  "object",
  "string"
]);
const KNOWN_KEYWORDS = new Set([
  "$id",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "deprecated",
  "description",
  "enum",
  "examples",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "not",
  "oneOf",
  "pattern",
  "properties",
  "readOnly",
  "required",
  "title",
  "type",
  "writeOnly"
]);
type CompositionKeyword = "allOf" | "anyOf" | "oneOf";
type CountKeyword = "maxItems" | "maxLength" | "minItems" | "minLength";
type NumberKeyword = "maximum" | "minimum";

type JsonObject = { readonly [key: string]: JsonValue };

type AnalysisState = {
  invalid: boolean;
  readonly diagnostics: StudioSchemaDiagnostic[];
};

export type StudioJsonSchemaAnalysis = {
  readonly diagnostics: readonly StudioSchemaDiagnostic[];
  readonly schema?: JsonSchemaLike;
};

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaInvalid(
  state: AnalysisState,
  schemaPath: string,
  keyword: string
): void {
  state.invalid = true;
  state.diagnostics.push({
    severity: "error",
    code: "schema_invalid",
    message: "The JSON Schema keyword has an invalid value",
    keyword,
    schema_path: schemaPath
  });
}

function unsupported(
  state: AnalysisState,
  schemaPath: string,
  keyword: string
): void {
  state.diagnostics.push({
    severity: "warning",
    code: "schema_keyword_unsupported",
    message: "The Luna runtime does not enforce this JSON Schema keyword",
    keyword,
    schema_path: schemaPath
  });
}

function stringAnnotation(
  object: JsonObject,
  keyword: "$id" | "$schema" | "title",
  path: string,
  state: AnalysisState
): void {
  if (keyword in object && typeof object[keyword] !== "string") {
    schemaInvalid(state, appendStudioSchemaPointer(path, keyword), keyword);
  }
}

function booleanAnnotation(
  object: JsonObject,
  keyword: "deprecated" | "readOnly" | "writeOnly",
  path: string,
  state: AnalysisState
): void {
  if (keyword in object && typeof object[keyword] !== "boolean") {
    schemaInvalid(state, appendStudioSchemaPointer(path, keyword), keyword);
  }
}

function parseType(
  value: JsonValue | undefined,
  path: string,
  state: AnalysisState
): JsonSchemaLike["type"] {
  if (value === undefined) {
    return undefined;
  }
  const values = typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : undefined;
  if (
    values === undefined ||
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some((type) => !JSON_SCHEMA_TYPES.has(type))
  ) {
    schemaInvalid(state, path, "type");
    return undefined;
  }
  if (values.some((type) => !RUNTIME_SCHEMA_TYPES.has(type))) {
    unsupported(state, path, "type");
  }
  return typeof value === "string" ? value : values;
}

function parseProperties(
  value: JsonValue | undefined,
  path: string,
  state: AnalysisState
): Record<string, JsonSchemaLike> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    schemaInvalid(state, path, "properties");
    return undefined;
  }
  const properties: [string, JsonSchemaLike][] = [];
  for (const [key, nested] of Object.entries(value)) {
    const parsed = parseSchemaNode(
      nested,
      appendStudioSchemaPointer(path, key),
      state
    );
    if (parsed !== undefined) {
      properties.push([key, parsed]);
    }
  }
  return Object.fromEntries(properties);
}

function parseSchemaArray(
  value: JsonValue | undefined,
  path: string,
  keyword: CompositionKeyword,
  state: AnalysisState
): readonly JsonSchemaLike[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    schemaInvalid(state, path, keyword);
    return undefined;
  }
  const schemas: JsonSchemaLike[] = [];
  value.forEach((nested, index) => {
    const parsed = parseSchemaNode(
      nested,
      appendStudioSchemaPointer(path, index),
      state
    );
    if (parsed !== undefined) {
      schemas.push(parsed);
    }
  });
  return schemas;
}

function parseRequired(
  value: JsonValue | undefined,
  path: string,
  state: AnalysisState
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string") ||
    new Set(value).size !== value.length
  ) {
    schemaInvalid(state, path, "required");
    return undefined;
  }
  return value;
}

function parseAdditionalProperties(
  value: JsonValue | undefined,
  path: string,
  state: AnalysisState
): JsonSchemaLike["additionalProperties"] {
  if (value === undefined || typeof value === "boolean") {
    return value;
  }
  const schema = parseSchemaNode(value, path, state);
  if (schema !== undefined) {
    unsupported(state, path, "additionalProperties");
  }
  return schema;
}

function parseCountKeyword(
  object: JsonObject,
  keyword: CountKeyword,
  path: string,
  state: AnalysisState
): number | undefined {
  const value = object[keyword];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    schemaInvalid(state, appendStudioSchemaPointer(path, keyword), keyword);
    return undefined;
  }
  return Number(value);
}

function parseNumberKeyword(
  object: JsonObject,
  keyword: NumberKeyword,
  path: string,
  state: AnalysisState
): number | undefined {
  const value = object[keyword];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    schemaInvalid(state, appendStudioSchemaPointer(path, keyword), keyword);
    return undefined;
  }
  return value;
}

function parsePattern(
  value: JsonValue | undefined,
  path: string,
  state: AnalysisState
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > 1_024) {
    schemaInvalid(state, path, "pattern");
    return undefined;
  }
  try {
    new RegExp(value);
  } catch {
    schemaInvalid(state, path, "pattern");
    return undefined;
  }
  return value;
}

function parseSchemaNode(
  value: JsonValue,
  path: string,
  state: AnalysisState
): JsonSchemaLike | undefined {
  if (!isJsonObject(value) || !isPlainObject(value)) {
    schemaInvalid(state, path, "schema");
    return undefined;
  }

  for (const keyword of Object.keys(value)) {
    if (!KNOWN_KEYWORDS.has(keyword)) {
      unsupported(
        state,
        appendStudioSchemaPointer(path, keyword),
        keyword
      );
    }
  }
  stringAnnotation(value, "$id", path, state);
  stringAnnotation(value, "$schema", path, state);
  stringAnnotation(value, "title", path, state);
  booleanAnnotation(value, "deprecated", path, state);
  booleanAnnotation(value, "readOnly", path, state);
  booleanAnnotation(value, "writeOnly", path, state);
  if (value.examples !== undefined && !Array.isArray(value.examples)) {
    schemaInvalid(
      state,
      appendStudioSchemaPointer(path, "examples"),
      "examples"
    );
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    schemaInvalid(
      state,
      appendStudioSchemaPointer(path, "description"),
      "description"
    );
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) {
    schemaInvalid(
      state,
      appendStudioSchemaPointer(path, "enum"),
      "enum"
    );
  }

  const type = parseType(
    value.type,
    appendStudioSchemaPointer(path, "type"),
    state
  );
  const properties = parseProperties(
    value.properties,
    appendStudioSchemaPointer(path, "properties"),
    state
  );
  const items = value.items === undefined
    ? undefined
    : parseSchemaNode(
        value.items,
        appendStudioSchemaPointer(path, "items"),
        state
      );
  const required = parseRequired(
    value.required,
    appendStudioSchemaPointer(path, "required"),
    state
  );
  const additionalProperties = parseAdditionalProperties(
    value.additionalProperties,
    appendStudioSchemaPointer(path, "additionalProperties"),
    state
  );
  const not = value.not === undefined
    ? undefined
    : parseSchemaNode(
        value.not,
        appendStudioSchemaPointer(path, "not"),
        state
      );
  const pattern = parsePattern(
    value.pattern,
    appendStudioSchemaPointer(path, "pattern"),
    state
  );
  const allOf = parseSchemaArray(
    value.allOf,
    appendStudioSchemaPointer(path, "allOf"),
    "allOf",
    state
  );
  const anyOf = parseSchemaArray(
    value.anyOf,
    appendStudioSchemaPointer(path, "anyOf"),
    "anyOf",
    state
  );
  const oneOf = parseSchemaArray(
    value.oneOf,
    appendStudioSchemaPointer(path, "oneOf"),
    "oneOf",
    state
  );
  const minItems = parseCountKeyword(value, "minItems", path, state);
  const maxItems = parseCountKeyword(value, "maxItems", path, state);
  const minLength = parseCountKeyword(value, "minLength", path, state);
  const maxLength = parseCountKeyword(value, "maxLength", path, state);
  const minimum = parseNumberKeyword(value, "minimum", path, state);
  const maximum = parseNumberKeyword(value, "maximum", path, state);

  return {
    ...(type === undefined ? {} : { type }),
    ...(properties === undefined ? {} : { properties }),
    ...(items === undefined ? {} : { items }),
    ...(required === undefined ? {} : { required }),
    ...(additionalProperties === undefined ? {} : { additionalProperties }),
    ...(Array.isArray(value.enum) ? { enum: value.enum } : {}),
    ...(Object.hasOwn(value, "const") ? { const: value.const } : {}),
    ...(allOf === undefined ? {} : { allOf }),
    ...(anyOf === undefined ? {} : { anyOf }),
    ...(oneOf === undefined ? {} : { oneOf }),
    ...(not === undefined ? {} : { not }),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }),
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum })
  };
}

export function analyzeStudioJsonSchema(
  document: Record<string, JsonValue>
): StudioJsonSchemaAnalysis {
  const state: AnalysisState = { invalid: false, diagnostics: [] };
  const schema = parseSchemaNode(document, "#", state);
  return {
    diagnostics: state.diagnostics,
    ...(state.invalid || schema === undefined ? {} : { schema })
  };
}
