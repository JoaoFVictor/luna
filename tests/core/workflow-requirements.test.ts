import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflowDefinition } from "../../src/core/workflow/definition.js";

async function tempWorkflowRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "luna-workflow-requirements-"));
}

async function writeWorkflow({
  root,
  graph,
  requires
}: {
  root: string;
  graph: string[];
  requires?: string[];
}): Promise<void> {
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
      ...(requires ?? []),
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(workflowDir, "graph.yaml"), graph.join("\n"), "utf8");
}

describe("workflow repository requirements", () => {
  it("keeps repository optional when graph has no repository-sensitive built-ins", async () => {
    const root = await tempWorkflowRoot();

    try {
      await writeWorkflow({
        root,
        graph: [
          "nodes:",
          "  - id: task_context",
          "    type: built_in",
          "    uses: collect_task_context",
          ""
        ]
      });

      await expect(loadWorkflowDefinition(root, "code-review")).resolves.toMatchObject({
        requires: { repository: false }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives repository requirements from repository-sensitive built-ins", async () => {
    const root = await tempWorkflowRoot();

    try {
      await writeWorkflow({
        root,
        graph: [
          "nodes:",
          "  - id: context",
          "    type: built_in",
          "    uses: collect_context",
          ""
        ]
      });

      await expect(loadWorkflowDefinition(root, "code-review")).resolves.toMatchObject({
        requires: { repository: true }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects workflows that disable repository while using repository-sensitive built-ins", async () => {
    const root = await tempWorkflowRoot();

    try {
      await writeWorkflow({
        root,
        requires: ["requires:", "  repository: false"],
        graph: [
          "nodes:",
          "  - id: context",
          "    type: built_in",
          "    uses: collect_context",
          ""
        ]
      });

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code: "workflow_repository_requirement_invalid"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
