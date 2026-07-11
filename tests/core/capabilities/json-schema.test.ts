import { describe, expect, it } from "vitest";
import {
  jsonSchemaMismatches,
  matchesJsonSchema
} from "../../../src/core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../../src/core/capabilities/json-schema-types.js";

describe("canonical JSON Schema matcher", () => {
  it.each([
    [{ type: "string", minLength: 2 }, "ok", true],
    [{ type: "string", minLength: 2 }, "x", false],
    [{ type: "integer", minimum: 1 }, 2, true],
    [{ type: "integer", minimum: 1 }, 0, false],
    [{ type: "boolean" }, false, true],
    [{ type: ["string", "number"] }, 42, true]
  ] satisfies readonly (readonly [JsonSchemaLike, unknown, boolean])[])(
    "keeps boolean matching aligned with diagnostics for %#",
    (schema, value, expected) => {
      expect(matchesJsonSchema(schema, value)).toBe(expected);
      expect(jsonSchemaMismatches(schema, value).length === 0).toBe(expected);
    }
  );

  it("reports canonical nested paths for object constraints", () => {
    const schema: JsonSchemaLike = {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        profile: {
          type: "object",
          properties: { age: { type: "integer", minimum: 18 } }
        }
      }
    };

    expect(
      jsonSchemaMismatches(schema, {
        profile: { age: 12 },
        unexpected: true
      })
    ).toEqual([
      {
        keyword: "required",
        instancePath: ["name"],
        schemaPath: ["required"]
      },
      {
        keyword: "additionalProperties",
        instancePath: ["unexpected"],
        schemaPath: ["additionalProperties"]
      },
      {
        keyword: "minimum",
        instancePath: ["profile", "age"],
        schemaPath: ["properties", "profile", "properties", "age", "minimum"]
      }
    ]);
  });

  it("reports item indices and aggregate array constraints", () => {
    expect(
      jsonSchemaMismatches(
        {
          type: "array",
          minItems: 3,
          items: { type: "string" }
        },
        ["ok", 42]
      )
    ).toEqual([
      {
        keyword: "minItems",
        instancePath: [],
        schemaPath: ["minItems"]
      },
      {
        keyword: "type",
        instancePath: [1],
        schemaPath: ["items", "type"]
      }
    ]);
  });

  it("keeps combinators and expression-object bypass semantics", () => {
    const schema: JsonSchemaLike = {
      anyOf: [{ type: "string" }, { type: "integer" }]
    };

    expect(jsonSchemaMismatches(schema, false)).toEqual([
      { keyword: "anyOf", instancePath: [], schemaPath: ["anyOf"] }
    ]);
    expect(
      jsonSchemaMismatches(schema, { expression: "$.steps.value" }, {
        isExpressionObject: (value) =>
          typeof value === "object" &&
          value !== null &&
          "expression" in value
      })
    ).toEqual([]);
  });

  it("preserves the runtime's declared additionalProperties subset", () => {
    const schema: JsonSchemaLike = {
      type: "object",
      additionalProperties: { type: "string" }
    };

    expect(matchesJsonSchema(schema, { count: 42 })).toBe(true);
    expect(jsonSchemaMismatches(schema, { count: 42 })).toEqual([]);
  });

  it("does not treat inherited object properties as JSON fields", () => {
    const schema: JsonSchemaLike = {
      type: "object",
      required: ["toString"]
    };

    expect(matchesJsonSchema(schema, {})).toBe(false);
    expect(jsonSchemaMismatches(schema, {})).toEqual([
      {
        keyword: "required",
        instancePath: ["toString"],
        schemaPath: ["required"]
      }
    ]);
  });
});
