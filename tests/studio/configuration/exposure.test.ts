import { describe, expect, it } from "vitest";
import {
  changedStudioConfigurationFields,
  projectStudioConfigurationExposure
} from "../../../src/studio/application/configuration/exposure.js";
import { StudioConfigurationFieldSchema } from "../../../src/studio/contracts/configuration.js";

const editable = { "x-luna-studio": { exposure: "editable" } } as const;
const readOnly = { "x-luna-studio": { exposure: "read_only" } } as const;

describe("Studio workflow configuration exposure", () => {
  it("projects only explicitly classified leaf values", () => {
    const secret = "UNCLASSIFIED_SECRET_CANARY_5f2e";
    const projection = projectStudioConfigurationExposure({
      schema: {
        type: "object",
        properties: {
          visible: { type: "string", ...editable },
          hidden: { type: "string" },
          nested: {
            type: "object",
            properties: {
              count: { type: "integer", ...readOnly },
              private_value: { type: "string" }
            }
          }
        }
      },
      value: {
        visible: "safe",
        hidden: secret,
        nested: { count: 3, private_value: secret }
      }
    });

    expect(projection.fields).toEqual([
      expect.objectContaining({
        path: ["nested", "count"],
        expression: "$.config.nested.count",
        exposure: "read_only",
        value: 3
      }),
      expect.objectContaining({
        path: ["visible"],
        expression: "$.config.visible",
        exposure: "editable",
        value: "safe"
      })
    ]);
    expect(projection.summary).toEqual({
      total_leaf_count: 4,
      classified_field_count: 2,
      unclassified_field_count: 2,
      unsupported_classified_field_count: 0
    });
    expect(JSON.stringify(projection)).not.toContain(secret);
  });

  it("does not treat unknown keywords or parent metadata as an allowlist", () => {
    const secret = "UNKNOWN_KEYWORD_SECRET_CANARY_17c1";
    const projection = projectStudioConfigurationExposure({
      schema: {
        type: "object",
        "x-luna-studio": { exposure: "editable" },
        properties: {
          fake: {
            type: "string",
            "x-studio-visible": true
          },
          child: { type: "string" }
        }
      },
      value: { fake: secret, child: secret }
    });

    expect(projection.fields).toEqual([]);
    expect(projection.summary.unclassified_field_count).toBe(2);
    expect(projection.summary.unsupported_classified_field_count).toBe(1);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "configuration_exposure_non_leaf" })
    );
    expect(JSON.stringify(projection)).not.toContain(secret);
  });

  it("treats writeOnly and malformed writeOnly as an absolute barrier", () => {
    const secret = "WRITE_ONLY_SECRET_CANARY_8bad";
    const projection = projectStudioConfigurationExposure({
      schema: {
        type: "object",
        properties: {
          direct: { type: "string", writeOnly: true, ...editable },
          malformed: { type: "string", writeOnly: "false", ...editable },
          parent: {
            type: "object",
            writeOnly: true,
            properties: {
              nested: { type: "string", ...editable }
            }
          },
          allowed: { type: "string", writeOnly: false, ...editable }
        }
      },
      value: {
        direct: secret,
        malformed: secret,
        parent: { nested: secret },
        allowed: "safe"
      }
    });

    expect(projection.fields).toEqual([
      expect.objectContaining({ path: ["allowed"], value: "safe" })
    ]);
    expect(
      projection.diagnostics.filter(
        (item) => item.code === "configuration_write_only_blocked"
      )
    ).toHaveLength(3);
    expect(JSON.stringify(projection)).not.toContain(secret);
  });

  it("supports primitive arrays but blocks nested arrays and object arrays", () => {
    const secret = "NESTED_ARRAY_SECRET_CANARY_9d21";
    const projection = projectStudioConfigurationExposure({
      schema: {
        type: "object",
        properties: {
          labels: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            ...editable
          },
          objects: {
            type: "array",
            items: {
              type: "object",
              properties: { token: { type: "string" } }
            },
            ...editable
          },
          nested_arrays: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
            ...editable
          }
        }
      },
      value: {
        labels: ["one", "two"],
        objects: [{ token: secret }],
        nested_arrays: [[secret]]
      }
    });

    expect(projection.fields).toEqual([
      expect.objectContaining({
        path: ["labels"],
        value_type: "string_array",
        value: ["one", "two"],
        min_items: 1
      })
    ]);
    expect(projection.summary.unsupported_classified_field_count).toBe(2);
    expect(JSON.stringify(projection)).not.toContain(secret);
  });

  it("filters incompatible and duplicate enum values without degrading constraints", () => {
    const projection = projectStudioConfigurationExposure({
      schema: {
        type: "object",
        properties: {
          compatible: {
            type: "string",
            enum: [1, "one", "one", "two"],
            ...editable
          },
          unsupported: {
            type: "string",
            enum: [1, true],
            ...editable
          }
        }
      },
      value: { compatible: "one", unsupported: "hidden" }
    });

    expect(projection.fields).toEqual([
      expect.objectContaining({
        path: ["compatible"],
        enum_values: ["one", "two"]
      })
    ]);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "configuration_enum_unsupported" })
    );
    expect(projection.summary.unsupported_classified_field_count).toBe(1);
  });

  it("rejects a field DTO whose enum does not match its declared type", () => {
    const parsed = StudioConfigurationFieldSchema.safeParse({
      path: ["choice"],
      expression: "$.config.choice",
      value_type: "string",
      exposure: "editable",
      required: true,
      present: true,
      value: "1",
      enum_values: [1, "1"]
    });

    expect(parsed.success).toBe(false);
  });

  it("withholds an installed value outside its projected enum", () => {
    const projection = projectStudioConfigurationExposure({
      schema: {
        type: "object",
        properties: {
          choice: { type: "string", enum: ["one", "two"], ...editable }
        }
      },
      value: { choice: "outside" }
    });

    expect(projection.fields).toEqual([
      expect.objectContaining({ path: ["choice"], present: false })
    ]);
    expect(projection.fields[0]).not.toHaveProperty("value");
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "configuration_value_enum_mismatch" })
    );
  });

  it("withholds an invalid runtime value even when its schema leaf is classified", () => {
    const secret = "TYPE_MISMATCH_SECRET_CANARY_1cae";
    const projection = projectStudioConfigurationExposure({
      schema: {
        type: "object",
        properties: {
          expected_string: { type: "string", ...editable }
        }
      },
      value: { expected_string: { secret } }
    });

    expect(projection.fields).toEqual([
      expect.objectContaining({
        path: ["expected_string"],
        present: false
      })
    ]);
    expect(projection.fields[0]).not.toHaveProperty("value");
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "configuration_value_type_mismatch" })
    );
    expect(JSON.stringify(projection)).not.toContain(secret);
  });

  it("computes value diffs strictly from already classified projections", () => {
    const before = projectStudioConfigurationExposure({
      schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", ...editable },
          hidden: { type: "string" }
        }
      },
      value: { enabled: false, hidden: "PRIVATE_BEFORE" }
    });
    const after = projectStudioConfigurationExposure({
      schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", ...editable },
          hidden: { type: "string" }
        }
      },
      value: { enabled: true, hidden: "PRIVATE_AFTER" }
    });

    const changes = changedStudioConfigurationFields(
      before.fields,
      after.fields
    );
    expect(changes).toEqual([
      {
        path: ["enabled"],
        before_present: true,
        before: false,
        after_present: true,
        after: true
      }
    ]);
    expect(JSON.stringify(changes)).not.toContain("PRIVATE_");
  });

  it("withholds classified root scalars and oversized property paths", () => {
    const rootSecret = "ROOT_SCALAR_SECRET_CANARY_c7c3";
    const root = projectStudioConfigurationExposure({
      schema: { type: "string", ...editable },
      value: rootSecret
    });
    expect(root.fields).toEqual([]);
    expect(root.diagnostics).toContainEqual(
      expect.objectContaining({ code: "configuration_root_leaf_unsupported" })
    );
    expect(JSON.stringify(root)).not.toContain(rootSecret);

    const oversizedKey = "k".repeat(129);
    const nestedSecret = "OVERSIZED_PATH_SECRET_CANARY_31c0";
    const nested = projectStudioConfigurationExposure({
      schema: {
        type: "object",
        properties: {
          [oversizedKey]: { type: "string", ...editable }
        }
      },
      value: { [oversizedKey]: nestedSecret }
    });
    expect(nested.fields).toEqual([]);
    expect(nested.diagnostics).toContainEqual(
      expect.objectContaining({ code: "configuration_path_segment_invalid" })
    );
    expect(JSON.stringify(nested)).not.toContain(nestedSecret);
    expect(JSON.stringify(nested)).not.toContain(oversizedKey);
  });
});
