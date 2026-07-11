import { describe, expect, it } from "vitest";
import { validateStudioPresentation } from "../../../src/core/capabilities/validation.js";

const schema = {
  type: "object",
  properties: {
    command: { type: "string" },
    timeout_ms: { type: "number" },
    enabled: { type: "boolean" },
    payload: { type: "object" },
    mode: { type: "string", enum: ["read", "write"] }
  }
} as const;

describe("Studio presentation schema hints", () => {
  it("resolves canonical escaped JSON Pointers against the owner schema", () => {
    const escapedSchema = {
      type: "object",
      properties: {
        "path/with~escape": { type: "string" }
      }
    } as const;
    const descriptor = {
      title: "Escaped field",
      field_hints: {
        "/properties/path~1with~0escape": { control: "text" }
      }
    } as const;

    expect(() =>
      validateStudioPresentation(descriptor, undefined, escapedSchema)
    ).not.toThrow();
  });

  it("accepts the empty JSON Pointer for the owner schema root", () => {
    const descriptor = {
      title: "Root field",
      field_hints: { "": { control: "json" } }
    } as const;

    expect(() =>
      validateStudioPresentation(descriptor, undefined, schema)
    ).not.toThrow();
  });

  it.each([
    ["text", "/properties/command"],
    ["textarea", "/properties/command"],
    ["number", "/properties/timeout_ms"],
    ["switch", "/properties/enabled"],
    ["json", "/properties/payload"],
    ["select", "/properties/mode"]
  ] as const)(
    "accepts the %s control for a compatible schema",
    (control, pointer) => {
      const descriptor = {
        title: "Compatible control",
        field_hints: { [pointer]: { control } }
      };

      expect(() =>
        validateStudioPresentation(descriptor, undefined, schema)
      ).not.toThrow();
    }
  );

  it("allows an intentionally empty placeholder", () => {
    const descriptor = {
      title: "No placeholder",
      field_hints: {
        "/properties/command": { control: "text", placeholder: "" }
      }
    } as const;

    expect(() =>
      validateStudioPresentation(descriptor, undefined, schema)
    ).not.toThrow();
  });

  it.each([
    ["a fragment pointer", "#/properties/command"],
    ["a pointer without a leading slash", "properties/command"],
    ["an invalid escape", "/properties/path~2value"],
    ["a missing target", "/properties/missing"],
    ["an invalid array index", "/oneOf/01"]
  ])("rejects %s", (_label, pointer) => {
    const ownerSchema = {
      ...schema,
      oneOf: [{ type: "string" }]
    } as const;
    const descriptor = {
      title: "Invalid pointer",
      field_hints: { [pointer]: { control: "text" } }
    };

    expect(() =>
      validateStudioPresentation(descriptor, undefined, ownerSchema)
    ).toThrow(
      expect.objectContaining({ code: "capability_presentation_invalid" })
    );
  });

  it("rejects field hints when the presentation has no owner schema", () => {
    const descriptor = {
      title: "Orphan hint",
      field_hints: { "/properties/command": { control: "text" } }
    } as const;

    expect(() => validateStudioPresentation(descriptor)).toThrow(
      expect.objectContaining({ code: "capability_presentation_invalid" })
    );
  });

  it.each([
    ["text on number", "/properties/timeout_ms", "text"],
    ["textarea on boolean", "/properties/enabled", "textarea"],
    ["number on string", "/properties/command", "number"],
    ["switch on object", "/properties/payload", "switch"],
    ["json on string", "/properties/command", "json"]
  ] as const)("rejects %s", (_label, pointer, control) => {
    const descriptor = {
      title: "Incompatible control",
      field_hints: { [pointer]: { control } }
    };

    expect(() =>
      validateStudioPresentation(descriptor, undefined, schema)
    ).toThrow(
      expect.objectContaining({ code: "capability_presentation_invalid" })
    );
  });

  it("rejects controls for schemas with ambiguous types", () => {
    const ownerSchema = {
      type: "object",
      properties: {
        value: { type: ["string", "number"] }
      }
    } as const;
    const descriptor = {
      title: "Ambiguous control",
      field_hints: { "/properties/value": { control: "text" } }
    } as const;

    expect(() =>
      validateStudioPresentation(descriptor, undefined, ownerSchema)
    ).toThrow(
      expect.objectContaining({ code: "capability_presentation_invalid" })
    );
  });

  it("rejects select controls for open string schemas", () => {
    const descriptor = {
      title: "Open select",
      field_hints: { "/properties/command": { control: "select" } }
    } as const;

    expect(() =>
      validateStudioPresentation(descriptor, undefined, schema)
    ).toThrow(
      expect.objectContaining({ code: "capability_presentation_invalid" })
    );
  });

  it.each([
    [
      "enum",
      { enum: ["read", "write"] },
      { read: "Read", write: "Write" }
    ],
    ["const", { const: "read" }, { read: "Read" }],
    [
      "oneOf const and enum",
      {
        oneOf: [{ const: "read" }, { enum: ["write", "review"] }]
      },
      { read: "Read", write: "Write", review: "Review" }
    ]
  ] as const)(
    "derives select values from a finite %s domain",
    (_label, owner, labels) => {
      const descriptor = {
        title: "Finite select",
        field_hints: {
          "": { control: "select", option_labels: labels }
        }
      } as const;

      expect(() =>
        validateStudioPresentation(descriptor, undefined, owner)
      ).not.toThrow();
    }
  );
});
