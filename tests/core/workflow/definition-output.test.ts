import { describe, expect, it } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { validateWorkflowNodeOutput } from "../../../src/core/workflow/definition.js";

const strictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["flag"],
  properties: {
    flag: { type: "boolean" }
  }
} as const;

const capabilityRegistry = createCapabilityRegistry([
  capabilityManifest({
    id: "test-output",
    kind: "execution",
    version: "2026.06.25",
    built_ins: {
      "test-output.strict_builtin": {
        id: "test-output.strict_builtin",
        input_schema: strictSchema,
        output_schema: strictSchema,
        required_ports: []
      }
    },
    patterns: {
      "test-output.strict_pattern": {
        id: "test-output.strict_pattern",
        declaring_node_type: "pattern",
        input_schema: strictSchema,
        output_schema: strictSchema,
        expand: { type: "declaring_node_subgraph" }
      }
    }
  })
]);

describe("workflow node output validation", () => {
  it("validates built-in and pattern payloads against registered output schemas", () => {
    expect(() =>
      validateWorkflowNodeOutput({
        node: {
          id: "strict",
          type: "built_in",
          uses: "test-output.strict_builtin"
        },
        output: { flag: "nope" },
        declaredCapabilities: ["test-output"],
        capabilityRegistry,
        path: "$.steps.strict.output"
      })
    ).toThrow(expect.objectContaining({
      code: "workflow_capability_config_invalid",
      capability: "test-output.strict_builtin"
    }));

    expect(() =>
      validateWorkflowNodeOutput({
        node: {
          id: "loop",
          type: "pattern",
          uses: "test-output.strict_pattern"
        },
        output: { flag: "nope" },
        declaredCapabilities: ["test-output"],
        capabilityRegistry,
        path: "$.steps.loop.output"
      })
    ).toThrow(expect.objectContaining({
      code: "workflow_capability_config_invalid",
      capability: "test-output.strict_pattern"
    }));
  });
});
