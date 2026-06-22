import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflowDefinition } from "../../src/core/workflow/definition.js";

async function workflowRootWithGraph(graphLines: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-workflow-gate-definition-"));
  const workflowDir = path.join(root, "implementation");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    path.join(workflowDir, "workflow.yaml"),
    [
      "id: implementation",
      "type: workflow",
      "mode: trusted_local_write",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(workflowDir, "graph.yaml"), graphLines.join("\n"), "utf8");
  return root;
}

describe("workflow gate definition", () => {
  it("rejects output_schema on gated agent gates", async () => {
    const root = await workflowRootWithGraph([
      "nodes:",
      "  - id: implementation",
      "    type: gated_agent_loop",
      "    agent: code-implementer",
      "    output_schema: implementation_result",
      "    sandbox:",
      "      type: trusted_host_local",
      "      cwd: $.workspace.path",
      "      env_allowlist: []",
      "    gates:",
      "      - id: review",
      "        type: agent",
      "        agent: change-reviewer",
      "        output_schema: implementation_review",
      "        block_when:",
      "          expression: $count(findings) > 0",
      "    repair:",
      "      attempts: 1",
      ""
    ]);

    try {
      await expect(loadWorkflowDefinition(root, "implementation")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
