import { describe, expect, it } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { validateWorkflowNodeOutput } from "../../../src/core/workflow/definition.js";
import { officialCapabilityRegistry } from "../../../src/capabilities/registry.js";

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

  it("accepts repository workspace output with artifact refs on both records", () => {
    expect(() =>
      validateWorkflowNodeOutput({
        node: {
          id: "workspace",
          type: "built_in",
          uses: "repository-workspace.capture"
        },
        output: {
          operation_id: "repository-workspace.capture",
          run_id: "run-1",
          repository_id: "repo-1",
          workspace_id: "repo-1:run-1",
          path: "/repo/workspaces/run-1",
          preserved: true,
          reason: "active",
          lifecycle: "active",
          captured_at: "2026-06-26T10:00:00.000Z",
          adopted: false,
          artifact: {
            id: "workspace-artifact",
            uri: "luna-artifact://workspace-artifact"
          },
          workspace: {
            operation_id: "repository-workspace.capture",
            run_id: "run-1",
            repository_id: "repo-1",
            workspace_id: "repo-1:run-1",
            path: "/repo/workspaces/run-1",
            preserved: true,
            reason: "active",
            lifecycle: "active",
            captured_at: "2026-06-26T10:00:00.000Z",
            artifact: {
              id: "workspace-artifact",
              uri: "luna-artifact://workspace-artifact"
            }
          },
          lock: {
            repository_id: "repo-1",
            token: "token-1",
            lifecycle: "released",
            acquired_at: "2026-06-26T09:59:59.000Z",
            release_reason: "success"
          }
        },
        declaredCapabilities: ["repository-workspace"],
        capabilityRegistry: officialCapabilityRegistry,
        path: "$.steps.workspace"
      })
    ).not.toThrow();
  });
});
