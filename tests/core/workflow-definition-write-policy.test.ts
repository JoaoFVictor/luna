import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflowDefinition } from "../../src/core/workflow/definition.js";

async function tempWorkflowRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "luna-workflow-write-policy-"));
}

async function writeReadOnlyWorkflowGraph(
  root: string,
  graphLines: string[]
): Promise<void> {
  const workflowDir = path.join(root, "code-review");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    path.join(workflowDir, "workflow.yaml"),
    [
      "id: code-review",
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(workflowDir, "graph.yaml"), graphLines.join("\n"), "utf8");
}

describe("workflow definition write policy", () => {
  it("rejects agent_loop nodes in read-only workflows", async () => {
    const root = await tempWorkflowRoot();

    try {
      await writeReadOnlyWorkflowGraph(root, [
        "nodes:",
        "  - id: implementation",
        "    type: agent_loop",
        "    agent: code-implementer",
        "    output_schema: implementation_result",
        "    sandbox:",
        "      type: trusted_host_local",
        "      cwd: $.workspace.path",
        "      env_allowlist: []",
        "    validation:",
        "      commands:",
        "        - cmd: npm",
        "          args:",
        "            - test",
        "      max_output_bytes: 200000",
        "    repair:",
        "      attempts: 0",
        ""
      ]);

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code: "workflow_read_only_write_node"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects write lifecycle built-ins in read-only workflows", async () => {
    const root = await tempWorkflowRoot();

    try {
      await writeReadOnlyWorkflowGraph(root, [
        "nodes:",
        "  - id: commit",
        "    type: built_in",
        "    uses: commit_changes",
        ""
      ]);

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code: "workflow_read_only_write_node"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
