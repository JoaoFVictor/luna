import { isDeepStrictEqual } from "node:util";
import {
  isPlainObject,
  type JsonValue
} from "../../../core/json/value.js";
import {
  STUDIO_CONFIGURATION_LIMITS,
  StudioConfigurationDiagnosticSchema,
  StudioConfigurationFieldSchema,
  studioConfigurationValueMatchesType,
  type StudioConfigurationDiagnostic,
  type StudioConfigurationField,
  type StudioConfigurationFieldPath,
  type StudioConfigurationValueType
} from "../../contracts/configuration.js";

export const STUDIO_CONFIGURATION_EXPOSURE_KEYWORD = "x-luna-studio";

type JsonObject = Readonly<Record<string, JsonValue>>;
type Exposure = StudioConfigurationField["exposure"];

export type StudioConfigurationExposureProjection = {
  readonly fields: readonly StudioConfigurationField[];
  readonly summary: {
    readonly total_leaf_count: number;
    readonly classified_field_count: number;
    readonly unclassified_field_count: number;
    readonly unsupported_classified_field_count: number;
  };
  readonly diagnostics: readonly StudioConfigurationDiagnostic[];
};

type ProjectionState = {
  totalLeaves: number;
  unclassifiedLeaves: number;
  unsupportedClassifiedLeaves: number;
  readonly fields: StudioConfigurationField[];
  readonly diagnostics: StudioConfigurationDiagnostic[];
};

function jsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isPlainObject(value)
    ? value
    : undefined;
}

function own(object: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function boundedText(
  value: JsonValue | undefined,
  maximumLength: number
): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
    ? value
    : undefined;
}

function diagnostic(
  state: ProjectionState,
  code: string,
  message: string,
  path: StudioConfigurationFieldPath,
  severity: StudioConfigurationDiagnostic["severity"] = "warning"
): void {
  if (state.diagnostics.length >= STUDIO_CONFIGURATION_LIMITS.maxDiagnostics) {
    return;
  }
  state.diagnostics.push(
    StudioConfigurationDiagnosticSchema.parse({
      severity,
      code,
      message,
      ...(path.length === 0 ? {} : { field_path: path })
    })
  );
}

function exposureMetadata(
  node: JsonObject,
  state: ProjectionState,
  path: StudioConfigurationFieldPath
): Exposure | undefined | "invalid" {
  const raw = own(node, STUDIO_CONFIGURATION_EXPOSURE_KEYWORD);
  if (raw === undefined) {
    return undefined;
  }
  const metadata = jsonObject(raw);
  if (
    metadata === undefined ||
    Object.keys(metadata).length !== 1 ||
    (metadata.exposure !== "editable" && metadata.exposure !== "read_only")
  ) {
    diagnostic(
      state,
      "configuration_exposure_invalid",
      "Studio exposure metadata is invalid and does not authorize a value",
      path,
      "error"
    );
    return "invalid";
  }
  return metadata.exposure;
}

function hasWriteOnlyBarrier(node: JsonObject): boolean {
  const writeOnly = own(node, "writeOnly");
  return writeOnly === true || (writeOnly !== undefined && writeOnly !== false);
}

function primitiveTypeFromValue(value: JsonValue):
  | "boolean"
  | "integer"
  | "number"
  | "string"
  | undefined {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return undefined;
}

function commonPrimitiveType(values: readonly JsonValue[]):
  | "boolean"
  | "integer"
  | "number"
  | "string"
  | undefined {
  if (values.length === 0) return undefined;
  const types = values.map(primitiveTypeFromValue);
  if (types.some((type) => type === undefined)) return undefined;
  const distinct = new Set(types);
  if (distinct.size === 1) return types[0];
  return distinct.size === 2 && distinct.has("integer") && distinct.has("number")
    ? "number"
    : undefined;
}

function declaredPrimitiveType(node: JsonObject):
  | "boolean"
  | "integer"
  | "number"
  | "string"
  | undefined {
  const declared = own(node, "type");
  if (
    declared === "boolean" ||
    declared === "integer" ||
    declared === "number" ||
    declared === "string"
  ) {
    return declared;
  }
  if (declared !== undefined) return undefined;

  const enumValues = own(node, "enum");
  if (Array.isArray(enumValues)) {
    return commonPrimitiveType(enumValues);
  }
  const constant = own(node, "const");
  return constant === undefined ? undefined : primitiveTypeFromValue(constant);
}

function supportedValueType(node: JsonObject): StudioConfigurationValueType | undefined {
  const primitive = declaredPrimitiveType(node);
  if (primitive !== undefined) return primitive;
  if (own(node, "type") !== "array") return undefined;
  const items = jsonObject(own(node, "items"));
  if (items === undefined || hasWriteOnlyBarrier(items)) return undefined;
  const itemType = declaredPrimitiveType(items);
  return itemType === undefined ? undefined : `${itemType}_array`;
}

function objectProperties(node: JsonObject): JsonObject | undefined {
  return jsonObject(own(node, "properties"));
}

function requiredProperties(node: JsonObject): ReadonlySet<string> {
  const required = own(node, "required");
  return new Set(
    Array.isArray(required)
      ? required.filter((item): item is string => typeof item === "string")
      : []
  );
}

function valueAtPath(
  root: JsonValue | undefined,
  path: StudioConfigurationFieldPath
): { readonly present: boolean; readonly value?: JsonValue } {
  let current = root;
  for (const segment of path) {
    const object = jsonObject(current);
    if (object === undefined || !Object.hasOwn(object, segment)) {
      return { present: false };
    }
    current = object[segment];
  }
  return current === undefined
    ? { present: false }
    : { present: true, value: current };
}

function expressionFor(path: StudioConfigurationFieldPath): string {
  return path.reduce((expression, segment) => {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
      ? `${expression}.${segment}`
      : `${expression}[${JSON.stringify(segment)}]`;
  }, "$.config");
}

function scalarEnumValues(
  node: JsonObject,
  type: StudioConfigurationValueType
): readonly (boolean | number | string)[] | undefined {
  const raw = own(node, "enum");
  if (raw === undefined) return undefined;
  if (
    type.endsWith("_array") ||
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > 256
  ) {
    return [];
  }
  const compatible = raw.filter(
    (value): value is boolean | number | string =>
      (typeof value === "boolean" ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))) &&
      studioConfigurationValueMatchesType(type, value)
  );
  if (compatible.length === 0) {
    return [];
  }
  return compatible.filter(
    (value, index) =>
      compatible.findIndex((candidate) => isDeepStrictEqual(candidate, value)) ===
      index
  );
}

function finiteNumber(
  node: JsonObject,
  key: "minimum" | "maximum"
): number | undefined {
  const value = own(node, key);
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nonnegativeInteger(
  node: JsonObject,
  key: "minLength" | "maxLength" | "minItems" | "maxItems"
): number | undefined {
  const value = own(node, key);
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function projectLeaf(
  node: JsonObject,
  rootValue: JsonValue | undefined,
  path: StudioConfigurationFieldPath,
  required: boolean,
  writeOnlyBarrier: boolean,
  state: ProjectionState
): void {
  state.totalLeaves += 1;
  const exposure = exposureMetadata(node, state, path);
  if (exposure === undefined) {
    state.unclassifiedLeaves += 1;
    return;
  }
  if (exposure === "invalid") {
    state.unsupportedClassifiedLeaves += 1;
    return;
  }
  if (path.length === 0) {
    state.unsupportedClassifiedLeaves += 1;
    diagnostic(
      state,
      "configuration_root_leaf_unsupported",
      "Studio configuration exposure requires an object property leaf",
      [],
      "error"
    );
    return;
  }
  if (writeOnlyBarrier || hasWriteOnlyBarrier(node)) {
    state.unsupportedClassifiedLeaves += 1;
    diagnostic(
      state,
      "configuration_write_only_blocked",
      "writeOnly configuration is never exposed by Studio",
      path
    );
    return;
  }
  const valueType = supportedValueType(node);
  if (valueType === undefined) {
    state.unsupportedClassifiedLeaves += 1;
    diagnostic(
      state,
      "configuration_field_unsupported",
      "The classified field uses a value shape that Studio does not expose",
      path
    );
    return;
  }
  if (own(node, "const") !== undefined && exposure === "editable") {
    state.unsupportedClassifiedLeaves += 1;
    diagnostic(
      state,
      "configuration_constant_not_editable",
      "A constant field cannot be classified as editable",
      path
    );
    return;
  }
  const enumValues = scalarEnumValues(node, valueType);
  if (enumValues?.length === 0) {
    state.unsupportedClassifiedLeaves += 1;
    diagnostic(
      state,
      "configuration_enum_unsupported",
      "The classified field enum has no unambiguous values for its supported type",
      path,
      "error"
    );
    return;
  }

  const selected = valueAtPath(rootValue, path);
  const typeMatches =
    selected.present &&
    selected.value !== undefined &&
    studioConfigurationValueMatchesType(valueType, selected.value);
  const enumMatches =
    enumValues === undefined ||
    enumValues.some((candidate) => candidate === selected.value);
  const safelyPresent = typeMatches && enumMatches;
  if (selected.present && !typeMatches) {
    diagnostic(
      state,
      "configuration_value_type_mismatch",
      "The installed value does not match the supported Studio field type and was withheld",
      path,
      "error"
    );
  } else if (typeMatches && !enumMatches) {
    diagnostic(
      state,
      "configuration_value_enum_mismatch",
      "The installed value is outside the supported Studio enum and was withheld",
      path,
      "error"
    );
  }

  const field = StudioConfigurationFieldSchema.parse({
    path,
    expression: expressionFor(path),
    value_type: valueType,
    exposure,
    required,
    present: safelyPresent,
    ...(safelyPresent ? { value: selected.value } : {}),
    ...(boundedText(own(node, "title"), 256) === undefined
      ? {}
      : { title: boundedText(own(node, "title"), 256) }),
    ...(boundedText(own(node, "description"), 2_000) === undefined
      ? {}
      : { description: boundedText(own(node, "description"), 2_000) }),
    ...(enumValues === undefined ? {} : { enum_values: enumValues }),
    ...(finiteNumber(node, "minimum") === undefined
      ? {}
      : { minimum: finiteNumber(node, "minimum") }),
    ...(finiteNumber(node, "maximum") === undefined
      ? {}
      : { maximum: finiteNumber(node, "maximum") }),
    ...(nonnegativeInteger(node, "minLength") === undefined
      ? {}
      : { min_length: nonnegativeInteger(node, "minLength") }),
    ...(nonnegativeInteger(node, "maxLength") === undefined
      ? {}
      : { max_length: nonnegativeInteger(node, "maxLength") }),
    ...(nonnegativeInteger(node, "minItems") === undefined
      ? {}
      : { min_items: nonnegativeInteger(node, "minItems") }),
    ...(nonnegativeInteger(node, "maxItems") === undefined
      ? {}
      : { max_items: nonnegativeInteger(node, "maxItems") })
  });
  state.fields.push(field);
}

function visitSchema(
  node: JsonObject,
  rootValue: JsonValue | undefined,
  path: StudioConfigurationFieldPath,
  required: boolean,
  writeOnlyBarrier: boolean,
  state: ProjectionState
): void {
  const properties = objectProperties(node);
  if (properties === undefined || Object.keys(properties).length === 0) {
    projectLeaf(node, rootValue, path, required, writeOnlyBarrier, state);
    return;
  }

  const exposure = exposureMetadata(node, state, path);
  if (exposure !== undefined) {
    state.unsupportedClassifiedLeaves += 1;
    diagnostic(
      state,
      "configuration_exposure_non_leaf",
      "Studio exposure must be declared on each supported leaf, never on a container",
      path,
      "error"
    );
  }
  const requiredChildren = requiredProperties(node);
  const childWriteOnlyBarrier = writeOnlyBarrier || hasWriteOnlyBarrier(node);
  for (const [key, child] of Object.entries(properties).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const childNode = jsonObject(child);
    if (childNode === undefined) {
      state.totalLeaves += 1;
      state.unclassifiedLeaves += 1;
      continue;
    }
    if (
      key.length === 0 ||
      key.length > STUDIO_CONFIGURATION_LIMITS.maxPathSegmentLength
    ) {
      state.totalLeaves += 1;
      const childExposure = exposureMetadata(childNode, state, path);
      if (childExposure === undefined) {
        state.unclassifiedLeaves += 1;
      } else {
        state.unsupportedClassifiedLeaves += 1;
      }
      diagnostic(
        state,
        "configuration_path_segment_invalid",
        "A configuration field path segment exceeds Studio's safe contract",
        path,
        "error"
      );
      continue;
    }
    if (path.length >= STUDIO_CONFIGURATION_LIMITS.maxPathDepth) {
      state.totalLeaves += 1;
      state.unsupportedClassifiedLeaves += 1;
      diagnostic(
        state,
        "configuration_path_too_deep",
        "The configuration schema exceeds Studio's supported path depth",
        path,
        "error"
      );
      continue;
    }
    visitSchema(
      childNode,
      rootValue,
      [...path, key],
      requiredChildren.has(key),
      childWriteOnlyBarrier,
      state
    );
  }
}

export function projectStudioConfigurationExposure(input: {
  readonly schema: JsonValue;
  readonly value?: JsonValue;
}): StudioConfigurationExposureProjection {
  const state: ProjectionState = {
    totalLeaves: 0,
    unclassifiedLeaves: 0,
    unsupportedClassifiedLeaves: 0,
    fields: [],
    diagnostics: []
  };
  const schema = jsonObject(input.schema);
  if (schema === undefined) {
    diagnostic(
      state,
      "configuration_schema_invalid",
      "The workflow configuration schema is not an object",
      [],
      "error"
    );
    return {
      fields: [],
      summary: {
        total_leaf_count: 0,
        classified_field_count: 0,
        unclassified_field_count: 0,
        unsupported_classified_field_count: 0
      },
      diagnostics: state.diagnostics
    };
  }
  visitSchema(schema, input.value, [], false, false, state);
  const fields = state.fields
    .slice(0, STUDIO_CONFIGURATION_LIMITS.maxFields)
    .sort((left, right) =>
      JSON.stringify(left.path).localeCompare(JSON.stringify(right.path))
    );
  if (state.fields.length > fields.length) {
    diagnostic(
      state,
      "configuration_fields_truncated",
      "Additional classified configuration fields were withheld",
      []
    );
  }
  return {
    fields,
    summary: {
      total_leaf_count: state.totalLeaves,
      classified_field_count: fields.length,
      unclassified_field_count: state.unclassifiedLeaves,
      unsupported_classified_field_count: state.unsupportedClassifiedLeaves
    },
    diagnostics: state.diagnostics
  };
}

export function changedStudioConfigurationFields(
  before: readonly StudioConfigurationField[],
  after: readonly StudioConfigurationField[]
): readonly {
  readonly path: StudioConfigurationFieldPath;
  readonly before_present: boolean;
  readonly before?: JsonValue;
  readonly after_present: boolean;
  readonly after?: JsonValue;
}[] {
  const beforeByPath = new Map(
    before.map((field) => [JSON.stringify(field.path), field])
  );
  return after.flatMap((field) => {
    const previous = beforeByPath.get(JSON.stringify(field.path));
    if (
      previous !== undefined &&
      previous.present === field.present &&
      isDeepStrictEqual(previous.value, field.value)
    ) {
      return [];
    }
    return [
      {
        path: field.path,
        before_present: previous?.present ?? false,
        ...(previous?.present === true ? { before: previous.value } : {}),
        after_present: field.present,
        ...(field.present ? { after: field.value } : {})
      }
    ];
  });
}
