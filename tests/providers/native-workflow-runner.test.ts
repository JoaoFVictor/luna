import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../src/core/agent-runtime/contracts.js";
import { capabilityManifest } from "../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../src/core/capabilities/registry.js";
import { createInitialRuntimeState } from "../../src/core/runtime/state.js";
import type { RunWorkflowInput } from "../../src/core/workflow/execution-contracts.js";
import { nativeLunaPlatformRegistrations } from "../../src/platform/native/native-platform-registrations.js";
import { runNativeWorkflowTarget } from "../../src/platform/native/native-workflow-runner.js";

describe("native workflow runner", () => {
  it("validates runtime composition before preparing the selected agent runtime", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-native-runner-"));
    const configRoot = path.join(projectRoot, "config");
    const workflowRoot = path.join(projectRoot, "workflows", "noop");
    const prepare = vi.fn();
    const agentRuntime: AgentRuntimePort = {
      describe: () => ({
        id: "custom.agent",
        display_name: "Custom Agent",
        supported_tool_protocols: [],
        supported_runtime_requirements: []
      }),
      validate: vi.fn(),
      runAgent: vi.fn()
    };

    try {
      await mkdir(configRoot, { recursive: true });
      await mkdir(workflowRoot, { recursive: true });
      await writeFile(
        path.join(configRoot, "app.yaml"),
        [
          "workspace:",
          "  strategy: git_worktree",
          "  root: .runs/workspaces",
          "  preserve_on_success: false",
          "  preserve_on_failure: true",
          "artifacts:",
          "  root: .runs",
          "workflow_runtime:",
          "  id: missing.workflow-runtime",
          "  options: {}",
          "agent_runtime:",
          "  id: custom.agent",
          "  options: {}",
          ""
        ].join("\n")
      );
      await writeFile(
        path.join(configRoot, "repositories.yaml"),
        ["repositories: []", ""].join("\n")
      );
      await writeFile(
        path.join(workflowRoot, "input.schema.json"),
        JSON.stringify({ type: "object", additionalProperties: true })
      );
      await writeFile(
        path.join(workflowRoot, "output.schema.json"),
        JSON.stringify({ type: "object", additionalProperties: true })
      );
      await writeFile(
        path.join(workflowRoot, "workflow.yaml"),
        [
          "id: noop",
          "type: workflow",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "capabilities:",
          "  - reports",
          "nodes:",
          "  - id: final_report",
          "    type: built_in",
          "    uses: reports.final_report",
          "    input:",
          "      sections:",
          "        - heading: Summary",
          "          content: ok",
          ""
        ].join("\n")
      );

      await expect(
        runNativeWorkflowTarget(
          {
            projectRoot,
            configRoot,
            target: { type: "workflow", id: "noop" },
            invocation: {
              version: "2026-06",
              source: "manual",
              event: "dispatch"
            }
          },
          {
            platform: {
              ...nativeLunaPlatformRegistrations,
              agentRuntimeFactories: {
                "custom.agent": {
                  id: "custom.agent",
                  prepare,
                  create: () => agentRuntime
                }
              },
              workflowRuntimeFactories: {}
            }
          }
        )
      ).rejects.toMatchObject({ code: "runtime_backend_invalid" });

      expect(prepare).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("loads and compiles workflows against the injected platform capability registry", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-native-platform-"));
    const configRoot = path.join(projectRoot, "config");
    const workflowRoot = path.join(projectRoot, "workflows", "custom-capability");
    const runWorkflow = vi.fn(async (input: RunWorkflowInput) => ({
      status: "succeeded" as const,
      output: { ok: true },
      state: createInitialRuntimeState({
        invocation: input.invocation,
        config: input.config,
        run: input.run,
        workflow: {
          id: input.workflow.id,
          mode: input.workflow.mode
        }
      })
    }));
    const customManifest = capabilityManifest({
      id: "custom",
      kind: "execution",
      version: "1.0.0",
      built_ins: {
        "custom.ok": {
          id: "custom.ok",
          input_schema: { type: "object" },
          output_schema: {
            type: "object",
            additionalProperties: false,
            required: ["ok"],
            properties: { ok: { type: "boolean" } }
          },
          required_ports: []
        }
      }
    });

    try {
      await mkdir(configRoot, { recursive: true });
      await mkdir(workflowRoot, { recursive: true });
      await writeFile(
        path.join(configRoot, "app.yaml"),
        [
          "workspace:",
          "  strategy: git_worktree",
          "  root: .runs/workspaces",
          "  preserve_on_success: false",
          "  preserve_on_failure: true",
          "artifacts:",
          "  root: .runs",
          "workflow_runtime:",
          "  id: custom.workflow-runtime",
          "  options: {}",
          "agent_runtime:",
          "  id: custom.agent-runtime",
          "  options: {}",
          ""
        ].join("\n")
      );
      await writeFile(path.join(configRoot, "repositories.yaml"), "repositories: []\n");
      await writeFile(
        path.join(workflowRoot, "input.schema.json"),
        JSON.stringify({ type: "object", additionalProperties: true })
      );
      await writeFile(
        path.join(workflowRoot, "output.schema.json"),
        JSON.stringify({
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } }
        })
      );
      await writeFile(
        path.join(workflowRoot, "workflow.yaml"),
        [
          "id: custom-capability",
          "type: workflow",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "capabilities:",
          "  - custom",
          "nodes:",
          "  - id: ok",
          "    type: built_in",
          "    uses: custom.ok",
          ""
        ].join("\n")
      );

      await expect(
        runNativeWorkflowTarget(
          {
            projectRoot,
            configRoot,
            target: { type: "workflow", id: "custom-capability" },
            invocation: {
              version: "2026-06",
              source: "manual",
              event: "dispatch"
            }
          },
          {
            platform: {
              capabilityRegistry: createCapabilityRegistry([customManifest]),
              capabilityManifests: [customManifest],
              agentRuntimeFactories: {
                "custom.agent-runtime": {
                  id: "custom.agent-runtime",
                  create: () => ({
                    describe: () => ({
                      id: "custom.agent-runtime",
                      display_name: "Custom Agent",
                      supported_tool_protocols: [],
                      supported_runtime_requirements: []
                    }),
                    validate: vi.fn(),
                    runAgent: vi.fn()
                  })
                }
              },
              workflowRuntimeFactories: {
                "custom.workflow-runtime": {
                  id: "custom.workflow-runtime",
                  create: () => ({ run: runWorkflow, resume: vi.fn() })
                }
              }
            }
          }
        )
      ).resolves.toBeUndefined();

      expect(runWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow: expect.objectContaining({ id: "custom-capability" }),
          compiled: expect.objectContaining({
            nodes: [
              expect.objectContaining({
                id: "ok",
                capability_id: "custom.ok"
              })
            ]
          })
        })
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
