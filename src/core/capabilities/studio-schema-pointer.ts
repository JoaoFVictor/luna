import type { JsonSchemaLike } from "./json-schema-types.js";
import { CapabilityValidationError } from "./validation-error.js";

type SchemaPointerCursor =
  | { readonly kind: "schema"; readonly value: JsonSchemaLike }
  | {
      readonly kind: "property_map";
      readonly value: Readonly<Record<string, JsonSchemaLike>>;
    }
  | { readonly kind: "schema_array"; readonly value: readonly JsonSchemaLike[] };

export function resolveStudioSchemaPointer(
  ownerSchema: JsonSchemaLike,
  pointer: string,
  path: string
): JsonSchemaLike {
  const tokens = parseCanonicalJsonPointer(pointer, path);
  let cursor: SchemaPointerCursor = { kind: "schema", value: ownerSchema };

  for (const token of tokens) {
    if (cursor.kind === "schema_array") {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) {
        pointerError(path, `pointer ${pointer} has an invalid array index`);
      }
      const index = Number(token);
      if (index >= cursor.value.length) {
        pointerError(path, `pointer ${pointer} does not resolve`);
      }
      cursor = { kind: "schema", value: cursor.value[index] };
      continue;
    }

    if (cursor.kind === "property_map") {
      const propertySchema: JsonSchemaLike | undefined = cursor.value[token];
      if (!Object.hasOwn(cursor.value, token) || propertySchema === undefined) {
        pointerError(path, `pointer ${pointer} does not resolve`);
      }
      cursor = { kind: "schema", value: propertySchema };
      continue;
    }

    cursor = descendSchemaPointer(cursor.value, token, pointer, path);
  }

  if (cursor.kind !== "schema") {
    pointerError(path, `pointer ${pointer} does not resolve to a schema`);
  }
  return cursor.value;
}

function descendSchemaPointer(
  schema: JsonSchemaLike,
  token: string,
  pointer: string,
  path: string
): SchemaPointerCursor {
  if (token === "properties" && schema.properties !== undefined) {
    return { kind: "property_map", value: schema.properties };
  }
  if (token === "items" && schema.items !== undefined) {
    return { kind: "schema", value: schema.items };
  }
  if (
    token === "additionalProperties" &&
    typeof schema.additionalProperties === "object"
  ) {
    return { kind: "schema", value: schema.additionalProperties };
  }
  if (token === "not" && schema.not !== undefined) {
    return { kind: "schema", value: schema.not };
  }
  if (token === "oneOf" && schema.oneOf !== undefined) {
    return { kind: "schema_array", value: schema.oneOf };
  }
  if (token === "anyOf" && schema.anyOf !== undefined) {
    return { kind: "schema_array", value: schema.anyOf };
  }
  if (token === "allOf" && schema.allOf !== undefined) {
    return { kind: "schema_array", value: schema.allOf };
  }

  pointerError(path, `pointer ${pointer} does not resolve to a schema`);
}

function parseCanonicalJsonPointer(pointer: string, path: string): string[] {
  if (pointer === "") {
    return [];
  }
  if (!pointer.startsWith("/")) {
    pointerError(path, `pointer ${pointer} is not canonical RFC 6901`);
  }

  return pointer.slice(1).split("/").map((token) => {
    if (/~(?:[^01]|$)/u.test(token)) {
      pointerError(path, `pointer ${pointer} has an invalid escape`);
    }
    const decoded = token.replace(/~1/g, "/").replace(/~0/g, "~");
    const canonical = decoded.replace(/~/g, "~0").replace(/\//g, "~1");
    if (canonical !== token) {
      pointerError(path, `pointer ${pointer} is not canonical RFC 6901`);
    }
    return decoded;
  });
}

function pointerError(label: string, reason: string): never {
  throw new CapabilityValidationError(
    "capability_presentation_invalid",
    `${label} ${reason}.`
  );
}
