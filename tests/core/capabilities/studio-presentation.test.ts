import { describe, expect, it } from "vitest";
import {
  capabilityManifest,
  type CapabilityManifest
} from "../../../src/core/capabilities/manifest.js";
import type { PatternRegistration } from "../../../src/core/capabilities/pattern-registration.js";
import type { StudioPresentation } from "../../../src/core/capabilities/studio-presentation.js";
import {
  validateCapabilityManifest,
  validatePatternRegistration,
  validateStudioPresentation
} from "../../../src/core/capabilities/validation.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    value: { type: "string" },
    command: { type: "string" },
    timeout_ms: { type: "number" },
    enabled: { type: "boolean" },
    payload: { type: "object" },
    mode: { type: "string", enum: ["read", "write"] }
  }
} as const;

const manifestPresentation = {
  title: "Studio test capability",
  summary: "Presentation for a capability catalog entry.",
  category: "Testing"
} as const satisfies StudioPresentation;

const presentation = {
  title: "Run command",
  summary: "Runs a deterministic command.",
  category: "Execution",
  tags: ["command", "deterministic"],
  icon: "terminal",
  examples: [
    {
      title: "Run the test suite",
      description: "Runs all repository tests.",
      value: { command: "npm test", timeout_ms: 30_000 }
    }
  ],
  field_hints: {
    "/properties/command": {
      label: "Command",
      description: "Command executed from the repository root.",
      control: "textarea",
      placeholder: "npm test"
    },
    "/properties/timeout_ms": { label: "Timeout", control: "number" },
    "/properties/mode": {
      label: "Mode",
      control: "select",
      option_labels: { read: "Read only", write: "Write" }
    }
  }
} as const satisfies StudioPresentation;

const registrationKinds = [
  "patterns",
  "built_ins",
  "tools",
  "gates",
  "policies",
  "ports",
  "artifact_publishers",
  "schemas"
] as const;

type RegistrationKind = (typeof registrationKinds)[number];

function manifestWithEveryRegistration(): CapabilityManifest {
  return capabilityManifest({
    id: "studio-test",
    kind: "execution",
    version: "2026.07.10",
    presentation: manifestPresentation,
    patterns: {
      "studio-test.pattern": {
        id: "studio-test.pattern",
        presentation,
        declaring_node_type: "pattern",
        input_schema: schema,
        output_schema: schema,
        expand: { type: "declaring_node_subgraph" }
      }
    },
    built_ins: {
      "studio-test.built-in": {
        id: "studio-test.built-in",
        presentation,
        input_schema: schema,
        output_schema: schema
      }
    },
    tools: {
      "studio-test.tool": {
        id: "studio-test.tool",
        presentation,
        protocol: "local",
        input_schema: schema,
        output_schema: schema
      }
    },
    gates: {
      "studio-test.gate": {
        id: "studio-test.gate",
        presentation,
        input_schema: schema,
        decision_schema: schema,
        output_schema: schema,
        interrupt: "none"
      }
    },
    policies: {
      "studio-test.policy": {
        id: "studio-test.policy",
        presentation,
        config_schema: schema
      }
    },
    ports: {
      "studio-test.port": {
        id: "studio-test.port",
        presentation,
        capability: "studio-test",
        option_schema: schema
      }
    },
    artifact_publishers: {
      "studio-test.publisher": {
        id: "studio-test.publisher",
        presentation,
        source_node_ownership: "declaring_node",
        path_policy: "declared_path",
        overwrite_policy: "forbid",
        config_schema: schema,
        manifest_transaction: "required"
      }
    },
    schemas: {
      "studio-test.schema": {
        id: "studio-test.schema",
        presentation,
        schema
      }
    }
  });
}

function registrationWithPresentation(
  kind: RegistrationKind,
  value: unknown
): CapabilityManifest {
  const manifest = manifestWithEveryRegistration();
  const registrations = manifest[kind] as Record<
    string,
    Record<string, unknown>
  >;
  const [id, registration] = Object.entries(registrations)[0] ?? [];

  if (id === undefined || registration === undefined) {
    throw new Error(`Missing test registration for ${kind}.`);
  }

  return {
    ...manifest,
    [kind]: {
      ...registrations,
      [id]: { ...registration, presentation: value }
    }
  } as CapabilityManifest;
}

describe("Studio capability presentation", () => {
  it("keeps presentation metadata manifest-owned for every registration kind", () => {
    const manifest = manifestWithEveryRegistration();
    const registrations = createCapabilityRegistry([manifest]).registrations();

    expect(validateCapabilityManifest(manifest)).toBe(manifest);
    expect(manifest.presentation).toBe(manifestPresentation);
    expect(
      registrations.built_ins.get("studio-test.built-in")?.presentation
    ).toBe(presentation);

    for (const kind of registrationKinds) {
      const registrations = manifest[kind];
      const registration = Object.values(registrations ?? {})[0];
      expect(registration?.presentation).toBe(presentation);
    }
  });

  it("allows presentation metadata on composition manifests", () => {
    const manifest = capabilityManifest({
      id: "studio-composition",
      kind: "composition",
      version: "2026.07.10",
      presentation: manifestPresentation
    });

    expect(validateCapabilityManifest(manifest)).toBe(manifest);
  });

  it.each([
    ["a non-object descriptor", null],
    ["a missing title", {}],
    ["a non-string title", { title: 42 }],
    ["an empty title", { title: "" }],
    ["a whitespace title", { title: "   " }],
    ["an unknown field", { title: "Title", color: "violet" }],
    ["a non-string summary", { title: "Title", summary: false }],
    ["an empty summary", { title: "Title", summary: "" }],
    ["a non-string category", { title: "Title", category: 1 }],
    ["an empty category", { title: "Title", category: " " }],
    ["non-array tags", { title: "Title", tags: "tag" }],
    ["non-string tags", { title: "Title", tags: ["valid", 1] }],
    ["empty tags", { title: "Title", tags: ["valid", ""] }],
    ["a non-string icon", { title: "Title", icon: {} }],
    ["an empty icon", { title: "Title", icon: " " }],
    ["non-array examples", { title: "Title", examples: {} }],
    ["non-record examples", { title: "Title", examples: ["example"] }],
    [
      "examples without titles",
      { title: "Title", examples: [{ value: "example" }] }
    ],
    [
      "examples without values",
      { title: "Title", examples: [{ title: "Example" }] }
    ],
    [
      "examples with empty titles",
      { title: "Title", examples: [{ title: " ", value: "example" }] }
    ],
    [
      "examples with empty descriptions",
      {
        title: "Title",
        examples: [{ title: "Example", description: "", value: "example" }]
      }
    ],
    [
      "unknown example fields",
      {
        title: "Title",
        examples: [{ title: "Example", value: {}, undocumented: true }]
      }
    ],
    [
      "non-JSON example values",
      {
        title: "Title",
        examples: [{ title: "Example", value: () => undefined }]
      }
    ],
    [
      "non-finite example numbers",
      { title: "Title", examples: [{ title: "Example", value: Infinity }] }
    ],
    ["non-record field hints", { title: "Title", field_hints: [] }],
    [
      "non-record field hint values",
      { title: "Title", field_hints: { "/properties/command": "text" } }
    ],
    [
      "unknown field hint fields",
      {
        title: "Title",
        field_hints: { "/properties/command": { language: "shell" } }
      }
    ],
    [
      "unsupported field controls",
      {
        title: "Title",
        field_hints: { "/properties/command": { control: "code" } }
      }
    ],
    [
      "a placeholder without a control",
      {
        title: "Title",
        field_hints: {
          "/properties/command": { placeholder: "npm test" }
        }
      }
    ],
    [
      "an empty field label",
      {
        title: "Title",
        field_hints: { "/properties/command": { label: "" } }
      }
    ],
    [
      "an empty field description",
      {
        title: "Title",
        field_hints: { "/properties/command": { description: " " } }
      }
    ],
    [
      "a placeholder on a switch control",
      {
        title: "Title",
        field_hints: {
          "/properties/enabled": {
            control: "switch",
            placeholder: "Enabled"
          }
        }
      }
    ],
    [
      "presentation-defined select values",
      {
        title: "Title",
        field_hints: {
          "/properties/mode": {
            control: "select",
            options: [{ label: "Delete", value: "delete" }]
          }
        }
      }
    ],
    [
      "non-record option labels",
      {
        title: "Title",
        field_hints: { "/properties/mode": { option_labels: [] } }
      }
    ],
    [
      "option labels without select",
      {
        title: "Title",
        field_hints: {
          "/properties/mode": {
            control: "text",
            option_labels: { read: "Read", write: "Write" }
          }
        }
      }
    ],
    [
      "incomplete option labels",
      {
        title: "Title",
        field_hints: {
          "/properties/mode": {
            control: "select",
            option_labels: { read: "Read" }
          }
        }
      }
    ],
    [
      "extra option labels",
      {
        title: "Title",
        field_hints: {
          "/properties/mode": {
            control: "select",
            option_labels: {
              read: "Read",
              write: "Write",
              delete: "Delete"
            }
          }
        }
      }
    ],
    [
      "non-string option labels",
      {
        title: "Title",
        field_hints: {
          "/properties/mode": {
            control: "select",
            option_labels: { read: "Read", write: 42 }
          }
        }
      }
    ],
    [
      "empty option labels",
      {
        title: "Title",
        field_hints: {
          "/properties/mode": {
            control: "select",
            option_labels: { read: "Read", write: "" }
          }
        }
      }
    ]
  ])("rejects %s", (_label, value) => {
    expect(() => validateStudioPresentation(value, undefined, schema)).toThrow(
      expect.objectContaining({ code: "capability_presentation_invalid" })
    );
  });

  it("rejects registration field hints when its owner schema is absent", () => {
    const manifest = manifestWithEveryRegistration();
    const publisher = manifest.artifact_publishers?.["studio-test.publisher"];
    if (publisher === undefined) {
      throw new Error("Missing publisher test registration.");
    }
    const withoutOwnerSchema = {
      ...manifest,
      artifact_publishers: {
        "studio-test.publisher": {
          ...publisher,
          config_schema: undefined
        }
      }
    } as unknown as CapabilityManifest;

    expect(() => validateCapabilityManifest(withoutOwnerSchema)).toThrow(
      expect.objectContaining({ code: "capability_presentation_invalid" })
    );
  });

  it("validates top-level manifest presentation metadata", () => {
    const manifest = {
      ...manifestWithEveryRegistration(),
      presentation: { title: "Invalid", undocumented: true }
    } as unknown as CapabilityManifest;

    expect(() => validateCapabilityManifest(manifest)).toThrow(
      expect.objectContaining({ code: "capability_presentation_invalid" })
    );
  });

  it.each(registrationKinds)(
    "validates presentation metadata on %s registrations",
    (kind) => {
      const manifest = registrationWithPresentation(kind, {
        title: "Invalid",
        examples: [{ title: "Example", value: Symbol("not-json") }]
      });

      expect(() => validateCapabilityManifest(manifest)).toThrow(
        expect.objectContaining({ code: "capability_presentation_invalid" })
      );
    }
  );

  it("validates pattern presentation when called through the pattern boundary", () => {
    const pattern = {
      id: "studio-test.pattern",
      declaring_node_type: "pattern",
      input_schema: schema,
      output_schema: schema,
      expand: { type: "declaring_node_subgraph" },
      presentation: { title: "Invalid", tags: [1] }
    } as const;

    expect(() =>
      validatePatternRegistration(
        "studio-test",
        pattern as unknown as PatternRegistration
      )
    ).toThrow(
      expect.objectContaining({ code: "capability_presentation_invalid" })
    );
  });
});
