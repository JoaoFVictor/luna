import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflowDefinition } from "../../src/core/workflow/definition.js";

async function copyLegacyFixture(fixtureName: string): Promise<string> {
  const root = path.join(tmpdir(), `luna-legacy-artifacts-${crypto.randomUUID()}`);
  const workflowDir = path.join(root, "legacy");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    path.join(workflowDir, "workflow.yaml"),
    [
      "id: legacy",
      "type: workflow",
      "mode: git_managed_read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ""
    ].join("\n"),
    "utf8"
  );
  const fixture = await readFile(
    path.join("tests", "fixtures", "workflows", fixtureName),
    "utf8"
  );
  await writeFile(path.join(workflowDir, "graph.yaml"), fixture, "utf8");

  return root;
}

describe("workflow definition legacy artifact rejection", () => {
  it("rejects legacy string artifact shape", async () => {
    const root = await copyLegacyFixture("legacy-artifact-string.graph.yaml");
    try {
      await expect(loadWorkflowDefinition(root, "legacy")).rejects.toMatchObject({
        code: "workflow_legacy_artifact_shape"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects legacy map artifact shape", async () => {
    const root = await copyLegacyFixture("legacy-artifact-map.graph.yaml");
    try {
      await expect(loadWorkflowDefinition(root, "legacy")).rejects.toMatchObject({
        code: "workflow_legacy_artifact_shape"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
