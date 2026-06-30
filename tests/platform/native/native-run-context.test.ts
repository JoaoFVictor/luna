import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { manifest as agents } from "../../../src/capabilities/agents/manifest.js";
import { manifest as artifacts } from "../../../src/capabilities/artifacts/manifest.js";
import { manifest as changeRequest } from "../../../src/capabilities/change-request/manifest.js";
import { manifest as context } from "../../../src/capabilities/context/manifest.js";
import { manifest as git } from "../../../src/capabilities/git/manifest.js";
import { manifest as qualityGates } from "../../../src/capabilities/quality-gates/manifest.js";
import { manifest as reports } from "../../../src/capabilities/reports/manifest.js";
import { manifest as repositoryChange } from "../../../src/capabilities/repository-change/manifest.js";
import { manifest as repositoryWorkspace } from "../../../src/capabilities/repository-workspace/manifest.js";
import { manifest as runtime } from "../../../src/capabilities/runtime/manifest.js";
import { manifest as taskContext } from "../../../src/capabilities/task-context/manifest.js";
import { manifest as validation } from "../../../src/capabilities/validation/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import {
  loadWorkflowDefinition,
  type WorkflowDefinition
} from "../../../src/core/workflow/definition.js";
import {
  compileNativeWorkflow,
  loadWorkflowRuntimeConfig
} from "../../../src/platform/native/native-run-context.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";

function workflowDefinition(
  overrides: Partial<WorkflowDefinition> = {}
): WorkflowDefinition {
  return {
    id: "custom-review",
    type: "workflow",
    mode: "read_only",
    directory: "/workflows/custom-review",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: { type: "object" },
    capabilities: [],
    graph: { nodes: [] },
    revision: "sha256:test",
    external_definition_digests: {},
    execution: { max_concurrency: 1 },
    requires: { repository: false },
    observability: {
      exporters: {
        runtime_log: { enabled: true, required: false }
      }
    },
    subagent_policy: { allow_write: false },
    ...overrides
  };
}

describe("native workflow runtime config", () => {
  it("compiles the bundled code-review workflow with specialist reviewers", async () => {
    const workflow = await loadWorkflowDefinition("workflows", "code-review", {
      agentsRoot: "agents",
      capabilityRegistry: nativeLunaPlatformRegistrations.capabilityRegistry
    });

    const nativeWorkflow = await compileNativeWorkflow({
      workflow,
      agentsRoot: "agents"
    });
    const nodeIds = nativeWorkflow.compiled.nodes.map((node) => node.id);

    expect(nodeIds).toEqual(expect.arrayContaining([
      "code_review",
      "security_review",
      "architecture_review",
      "merged_findings",
      "validated_findings",
      "publish_review"
    ]));
    expect(
      nativeWorkflow.workflow.graph.nodes
        .filter((node) =>
          ["code_review", "security_review", "architecture_review"].includes(node.id)
        )
        .every((node) =>
          node.type === "agent" && node.agent_session?.isolation === "shared"
        )
    ).toBe(true);
  });

  it("loads workflow-declared config for any workflow id and mode", async () => {
    const configRoot = await mkdtemp(path.join(tmpdir(), "luna-runtime-config-"));

    try {
      await writeFile(
        path.join(configRoot, "custom-review.yaml"),
        "custom_review:\n  enabled: true\n",
        "utf8"
      );

      await expect(
        loadWorkflowRuntimeConfig({
          configRoot,
          workflow: workflowDefinition({
            config: {
              file: "custom-review.yaml",
              schema: "config.schema.json",
              schema_content: {
                type: "object",
                additionalProperties: false,
                required: ["custom_review"],
                properties: {
                  custom_review: {
                    type: "object",
                    additionalProperties: false,
                    required: ["enabled"],
                    properties: {
                      enabled: { type: "boolean" }
                    }
                  }
                }
              }
            }
          })
        })
      ).resolves.toEqual({
        custom_review: {
          enabled: true
        }
      });
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  });

  it("returns an empty config when the workflow declares no config", async () => {
    await expect(
      loadWorkflowRuntimeConfig({
        configRoot: "/unused",
        workflow: workflowDefinition()
      })
    ).resolves.toEqual({});
  });

  it("loads implementation config with the maximum supported repair attempts", async () => {
    const configRoot = await mkdtemp(path.join(tmpdir(), "luna-runtime-config-"));

    try {
      const source = await readFile("config/implementation.yaml", "utf8");
      await writeFile(
        path.join(configRoot, "implementation.yaml"),
        source.replace("repair_attempts: 1", "repair_attempts: 9"),
        "utf8"
      );
      const workflow = await loadWorkflowDefinition("workflows", "implementation", {
        capabilityRegistry: createCapabilityRegistry([
          agents,
          artifacts,
          changeRequest,
          context,
          git,
          qualityGates,
          reports,
          repositoryChange,
          repositoryWorkspace,
          runtime,
          taskContext,
          validation
        ])
      });

      await expect(
        loadWorkflowRuntimeConfig({ workflow, configRoot })
      ).resolves.toMatchObject({
        implementation: {
          validation: {
            repair_attempts: 9
          }
        }
      });
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  });
});
