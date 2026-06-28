import type { JsonSchemaLike } from "./json-schema-types.js";

export type JsonSchemaMatcherOptions = {
  readonly isExpressionObject?: (value: unknown) => boolean;
};

export function matchesJsonSchema(
  schema: JsonSchemaLike,
  value: unknown,
  options: JsonSchemaMatcherOptions = {}
): boolean {
  if (options.isExpressionObject?.(value)) {
    return true;
  }
  if (schema.const !== undefined && schema.const !== value) {
    return false;
  }
  if (schema.enum !== undefined) {
    return schema.enum.some((item) => item === value);
  }
  if (
    schema.allOf !== undefined &&
    !schema.allOf.every((option) => matchesJsonSchema(option, value, options))
  ) {
    return false;
  }
  if (
    schema.anyOf !== undefined &&
    !schema.anyOf.some((option) => matchesJsonSchema(option, value, options))
  ) {
    return false;
  }
  if (schema.oneOf !== undefined) {
    const matchingOptions = schema.oneOf.filter((option) =>
      matchesJsonSchema(option, value, options)
    );
    if (matchingOptions.length !== 1) {
      return false;
    }
  }
  if (schema.not !== undefined && matchesJsonSchema(schema.not, value, options)) {
    return false;
  }
  if (schema.type === undefined) {
    return hasObjectKeywords(schema) ? matchesObjectSchema(schema, value, options) : true;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.some((type) =>
      matchesJsonSchema({ ...schema, type }, value, options)
    );
  }
  if (schema.type === "string") {
    return matchesStringSchema(schema, value);
  }
  if (schema.type === "number" || schema.type === "integer") {
    return typeof value === "number" &&
      Number.isFinite(value) &&
      (schema.type !== "integer" || Number.isInteger(value)) &&
      (schema.minimum === undefined || value >= schema.minimum) &&
      (schema.maximum === undefined || value <= schema.maximum);
  }
  if (schema.type === "boolean") {
    return typeof value === "boolean";
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      return false;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return false;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return false;
    }
    return schema.items === undefined ||
      value.every((item) =>
        matchesJsonSchema(schema.items as JsonSchemaLike, item, options)
      );
  }
  if (schema.type !== "object") {
    return true;
  }

  return matchesObjectSchema(schema, value, options);
}

function matchesStringSchema(schema: JsonSchemaLike, value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  if (schema.minLength !== undefined && value.length < schema.minLength) {
    return false;
  }

  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    return false;
  }

  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    return false;
  }

  return true;
}

function hasObjectKeywords(schema: JsonSchemaLike): boolean {
  return (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined
  );
}

function matchesObjectSchema(
  schema: JsonSchemaLike,
  value: unknown,
  options: JsonSchemaMatcherOptions
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const required of schema.required ?? []) {
    if (!(required in record)) {
      return false;
    }
  }
  const properties = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!(key in properties)) {
        return false;
      }
    }
  }
  return Object.entries(properties).every(([key, nested]) =>
    !(key in record) || matchesJsonSchema(nested, record[key], options)
  );
}
