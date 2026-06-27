import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../src/core/agent-runtime/contracts.js";
import { runNativeWorkflowTarget } from "../../src/providers/native-workflow-runner.js";

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
            agentRuntimeFactories: {
              "custom.agent": {
                id: "custom.agent",
                prepare,
                create: () => agentRuntime
              }
            },
            workflowRuntimeFactories: {}
          }
        )
      ).rejects.toMatchObject({ code: "runtime_backend_invalid" });

      expect(prepare).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
