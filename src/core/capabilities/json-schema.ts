import type { JsonSchemaLike } from "./json-schema-types.js";

export type JsonSchemaMatcherOptions = {
  readonly isExpressionObject?: (value: unknown) => boolean;
};

export type JsonSchemaPathSegment = string | number;

export type JsonSchemaMismatch = {
  readonly keyword: string;
  readonly instancePath: readonly JsonSchemaPathSegment[];
  readonly schemaPath: readonly JsonSchemaPathSegment[];
};

type MismatchReporter = (mismatch: JsonSchemaMismatch) => void;

function reportMismatch(
  reporter: MismatchReporter | undefined,
  keyword: string,
  instancePath: readonly JsonSchemaPathSegment[],
  schemaPath: readonly JsonSchemaPathSegment[]
): void {
  reporter?.({
    keyword,
    instancePath,
    schemaPath: [...schemaPath, keyword]
  });
}

function validateStringSchema(
  schema: JsonSchemaLike,
  value: unknown,
  instancePath: readonly JsonSchemaPathSegment[],
  schemaPath: readonly JsonSchemaPathSegment[],
  reporter: MismatchReporter | undefined
): boolean {
  if (typeof value !== "string") {
    reportMismatch(reporter, "type", instancePath, schemaPath);
    return false;
  }

  let matches = true;
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    reportMismatch(reporter, "minLength", instancePath, schemaPath);
    if (reporter === undefined) {
      return false;
    }
    matches = false;
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    reportMismatch(reporter, "maxLength", instancePath, schemaPath);
    if (reporter === undefined) {
      return false;
    }
    matches = false;
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    reportMismatch(reporter, "pattern", instancePath, schemaPath);
    if (reporter === undefined) {
      return false;
    }
    matches = false;
  }
  return matches;
}

function hasObjectKeywords(schema: JsonSchemaLike): boolean {
  return (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined
  );
}

function validateObjectSchema(
  schema: JsonSchemaLike,
  value: unknown,
  options: JsonSchemaMatcherOptions,
  instancePath: readonly JsonSchemaPathSegment[],
  schemaPath: readonly JsonSchemaPathSegment[],
  reporter: MismatchReporter | undefined
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reportMismatch(reporter, "type", instancePath, schemaPath);
    return false;
  }
  const record = value as Record<string, unknown>;
  const properties = schema.properties ?? {};
  let matches = true;

  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(record, required)) {
      reportMismatch(
        reporter,
        "required",
        [...instancePath, required],
        schemaPath
      );
      if (reporter === undefined) {
        return false;
      }
      matches = false;
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!Object.hasOwn(properties, key)) {
        reportMismatch(
          reporter,
          "additionalProperties",
          [...instancePath, key],
          schemaPath
        );
        if (reporter === undefined) {
          return false;
        }
        matches = false;
      }
    }
  }
  for (const [key, nested] of Object.entries(properties)) {
    if (
      Object.hasOwn(record, key) &&
      !validateSchema(
        nested,
        record[key],
        options,
        [...instancePath, key],
        [...schemaPath, "properties", key],
        reporter
      )
    ) {
      if (reporter === undefined) {
        return false;
      }
      matches = false;
    }
  }
  return matches;
}

function validateArraySchema(
  schema: JsonSchemaLike,
  value: unknown,
  options: JsonSchemaMatcherOptions,
  instancePath: readonly JsonSchemaPathSegment[],
  schemaPath: readonly JsonSchemaPathSegment[],
  reporter: MismatchReporter | undefined
): boolean {
  if (!Array.isArray(value)) {
    reportMismatch(reporter, "type", instancePath, schemaPath);
    return false;
  }
  let matches = true;
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    reportMismatch(reporter, "minItems", instancePath, schemaPath);
    if (reporter === undefined) {
      return false;
    }
    matches = false;
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    reportMismatch(reporter, "maxItems", instancePath, schemaPath);
    if (reporter === undefined) {
      return false;
    }
    matches = false;
  }
  const items = schema.items;
  if (items !== undefined) {
    for (const [index, item] of value.entries()) {
      if (
        !validateSchema(
          items,
          item,
          options,
          [...instancePath, index],
          [...schemaPath, "items"],
          reporter
        )
      ) {
        if (reporter === undefined) {
          return false;
        }
        matches = false;
      }
    }
  }
  return matches;
}

function validateNumberSchema(
  schema: JsonSchemaLike,
  value: unknown,
  instancePath: readonly JsonSchemaPathSegment[],
  schemaPath: readonly JsonSchemaPathSegment[],
  reporter: MismatchReporter | undefined
): boolean {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (schema.type === "integer" && !Number.isInteger(value))
  ) {
    reportMismatch(reporter, "type", instancePath, schemaPath);
    return false;
  }
  let matches = true;
  if (schema.minimum !== undefined && value < schema.minimum) {
    reportMismatch(reporter, "minimum", instancePath, schemaPath);
    if (reporter === undefined) {
      return false;
    }
    matches = false;
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    reportMismatch(reporter, "maximum", instancePath, schemaPath);
    if (reporter === undefined) {
      return false;
    }
    matches = false;
  }
  return matches;
}

function validateSchema(
  schema: JsonSchemaLike,
  value: unknown,
  options: JsonSchemaMatcherOptions,
  instancePath: readonly JsonSchemaPathSegment[],
  schemaPath: readonly JsonSchemaPathSegment[],
  reporter: MismatchReporter | undefined
): boolean {
  if (options.isExpressionObject?.(value)) {
    return true;
  }
  if (schema.const !== undefined && schema.const !== value) {
    reportMismatch(reporter, "const", instancePath, schemaPath);
    return false;
  }
  if (schema.enum !== undefined) {
    const matches = schema.enum.some((item) => item === value);
    if (!matches) {
      reportMismatch(reporter, "enum", instancePath, schemaPath);
    }
    return matches;
  }
  if (
    schema.allOf !== undefined &&
    !schema.allOf.every((option) =>
      validateSchema(option, value, options, instancePath, schemaPath, undefined)
    )
  ) {
    reportMismatch(reporter, "allOf", instancePath, schemaPath);
    return false;
  }
  if (
    schema.anyOf !== undefined &&
    !schema.anyOf.some((option) =>
      validateSchema(option, value, options, instancePath, schemaPath, undefined)
    )
  ) {
    reportMismatch(reporter, "anyOf", instancePath, schemaPath);
    return false;
  }
  if (schema.oneOf !== undefined) {
    const matchingOptions = schema.oneOf.filter((option) =>
      validateSchema(option, value, options, instancePath, schemaPath, undefined)
    );
    if (matchingOptions.length !== 1) {
      reportMismatch(reporter, "oneOf", instancePath, schemaPath);
      return false;
    }
  }
  if (
    schema.not !== undefined &&
    validateSchema(
      schema.not,
      value,
      options,
      instancePath,
      schemaPath,
      undefined
    )
  ) {
    reportMismatch(reporter, "not", instancePath, schemaPath);
    return false;
  }
  if (schema.type === undefined) {
    return hasObjectKeywords(schema)
      ? validateObjectSchema(
          schema,
          value,
          options,
          instancePath,
          schemaPath,
          reporter
        )
      : true;
  }
  if (Array.isArray(schema.type)) {
    const matches = schema.type.some((type) =>
      validateSchema(
        { ...schema, type },
        value,
        options,
        instancePath,
        schemaPath,
        undefined
      )
    );
    if (!matches) {
      reportMismatch(reporter, "type", instancePath, schemaPath);
    }
    return matches;
  }
  if (schema.type === "string") {
    return validateStringSchema(
      schema,
      value,
      instancePath,
      schemaPath,
      reporter
    );
  }
  if (schema.type === "number" || schema.type === "integer") {
    return validateNumberSchema(
      schema,
      value,
      instancePath,
      schemaPath,
      reporter
    );
  }
  if (schema.type === "boolean") {
    const matches = typeof value === "boolean";
    if (!matches) {
      reportMismatch(reporter, "type", instancePath, schemaPath);
    }
    return matches;
  }
  if (schema.type === "array") {
    return validateArraySchema(
      schema,
      value,
      options,
      instancePath,
      schemaPath,
      reporter
    );
  }
  if (schema.type === "object") {
    return validateObjectSchema(
      schema,
      value,
      options,
      instancePath,
      schemaPath,
      reporter
    );
  }

  return true;
}

export function matchesJsonSchema(
  schema: JsonSchemaLike,
  value: unknown,
  options: JsonSchemaMatcherOptions = {}
): boolean {
  return validateSchema(schema, value, options, [], [], undefined);
}

export function jsonSchemaMismatches(
  schema: JsonSchemaLike,
  value: unknown,
  options: JsonSchemaMatcherOptions = {}
): readonly JsonSchemaMismatch[] {
  const mismatches: JsonSchemaMismatch[] = [];
  validateSchema(schema, value, options, [], [], (mismatch) => {
    mismatches.push(mismatch);
  });
  return mismatches;
}
