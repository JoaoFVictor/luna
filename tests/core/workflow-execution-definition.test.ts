import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflowDefinition } from "../../src/core/workflow/definition.js";

async function tempWorkflowRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "luna-workflow-execution-"));
}

describe("workflow execution metadata", () => {
  it("parses explicit positive execution metadata", async () => {
    const root = await tempWorkflowRoot();
    try {
      await mkdir(path.join(root, "explicit"), { recursive: true });
      await writeFile(
        path.join(root, "explicit", "workflow.yaml"),
        [
          "id: explicit",
          "type: workflow",
          "mode: read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "graph: graph.yaml",
          "execution:",
          "  max_concurrency: 3",
          "  lock_timeout_ms: 1000",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(root, "explicit", "graph.yaml"),
        [
          "nodes:",
          "  - id: preflight",
          "    type: built_in",
          "    uses: preflight",
          ""
        ].join("\n"),
        "utf8"
      );

      const definition = await loadWorkflowDefinition(root, "explicit");
      expect(definition.execution).toEqual({
        max_concurrency: 3,
        lock_timeout_ms: 1000
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
