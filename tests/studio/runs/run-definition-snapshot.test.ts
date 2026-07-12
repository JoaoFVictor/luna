import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureNativeStudioDraftRunSnapshot } from "../../../src/studio/adapters/native/run-definition-snapshot.js";
import type { StudioDraftItem } from "../../../src/studio/contracts/draft-authoring.js";

const roots: string[] = [];
const schema = '{"type":"object","additionalProperties":true}\n';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Studio run definition snapshot", () => {
  it("captures an installed composed workflow used by a saved draft", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "luna-run-subworkflow-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    const configRoot = path.join(root, "config");
    const childRoot = path.join(projectRoot, "workflows", "child-flow");
    const grandchildRoot = path.join(projectRoot, "workflows", "grandchild-flow");
    await Promise.all([
      mkdir(childRoot, { recursive: true }),
      mkdir(grandchildRoot, { recursive: true }),
      mkdir(configRoot, { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(childRoot, "workflow.yaml"), [
        "id: child-flow",
        "type: workflow",
        "mode: read_only",
        "input_schema: input.schema.json",
        "output_schema: output.schema.json",
        "capabilities: []",
        "nodes:",
        "  - id: grandchild",
        "    type: workflow",
        "    workflow: grandchild-flow",
        "    input: {}",
        ""
      ].join("\n"), "utf8"),
      writeFile(path.join(childRoot, "input.schema.json"), schema, "utf8"),
      writeFile(path.join(childRoot, "output.schema.json"), schema, "utf8"),
      writeFile(path.join(grandchildRoot, "workflow.yaml"), [
        "id: grandchild-flow",
        "type: workflow",
        "mode: read_only",
        "input_schema: input.schema.json",
        "output_schema: output.schema.json",
        "capabilities: []",
        "nodes: []",
        ""
      ].join("\n"), "utf8"),
      writeFile(path.join(grandchildRoot, "input.schema.json"), schema, "utf8"),
      writeFile(path.join(grandchildRoot, "output.schema.json"), schema, "utf8")
    ]);
    const parentSource = [
      "id: parent-flow",
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "capabilities: []",
      "nodes:",
      "  - id: child",
      "    type: workflow",
      "    workflow: child-flow",
      "    input: {}",
      ""
    ].join("\n");
    const draft: StudioDraftItem = {
      draft_id: "40e67383-a2ce-4c41-93f5-23fc5354ba27",
      record_revision: 1,
      content_revision: 1,
      layout_revision: 0,
      primary_resource: { kind: "workflow", id: "parent-flow" },
      status: "valid",
      draft_hash: `sha256:${"a".repeat(64)}`,
      etag: "saved-parent",
      files: [
        {
          file: { root: "project", path: "workflows/parent-flow/workflow.yaml" },
          media_type: "application/yaml",
          state: "present",
          content: parentSource
        },
        ...["input.schema.json", "output.schema.json"].map((name) => ({
          file: { root: "project" as const, path: `workflows/parent-flow/${name}` },
          media_type: "application/json" as const,
          state: "present" as const,
          content: schema
        }))
      ],
      created_at: "2026-07-11T12:00:00.000Z",
      updated_at: "2026-07-11T12:00:00.000Z"
    };

    const snapshot = await captureNativeStudioDraftRunSnapshot({
      projectRoot,
      configRoot,
      draft
    });

    expect(snapshot.files.map((file) => `${file.root}/${file.path}`)).toEqual(
      expect.arrayContaining([
        "project/workflows/child-flow/workflow.yaml",
        "project/workflows/child-flow/input.schema.json",
        "project/workflows/child-flow/output.schema.json",
        "project/workflows/grandchild-flow/workflow.yaml",
        "project/workflows/grandchild-flow/input.schema.json",
        "project/workflows/grandchild-flow/output.schema.json"
      ])
    );
  });

  it("maps unsafe recursive workflow references to the run-plan contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "luna-run-invalid-child-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    const configRoot = path.join(root, "config");
    await mkdir(configRoot, { recursive: true });
    const draft: StudioDraftItem = {
      draft_id: "40e67383-a2ce-4c41-93f5-23fc5354ba28",
      record_revision: 1,
      content_revision: 1,
      layout_revision: 0,
      primary_resource: { kind: "workflow", id: "parent-flow" },
      status: "valid",
      draft_hash: `sha256:${"a".repeat(64)}`,
      etag: "invalid-child",
      files: [
        {
          file: { root: "project", path: "workflows/parent-flow/workflow.yaml" },
          media_type: "application/yaml",
          state: "present",
          content: [
            "id: parent-flow",
            "type: workflow",
            "mode: read_only",
            "input_schema: input.schema.json",
            "output_schema: output.schema.json",
            "capabilities: []",
            "nodes:",
            "  - id: child",
            "    type: workflow",
            "    workflow: ../escape",
            "    input: {}",
            ""
          ].join("\n")
        },
        ...["input.schema.json", "output.schema.json"].map((name) => ({
          file: { root: "project" as const, path: `workflows/parent-flow/${name}` },
          media_type: "application/json" as const,
          state: "present" as const,
          content: schema
        }))
      ],
      created_at: "2026-07-11T12:00:00.000Z",
      updated_at: "2026-07-11T12:00:00.000Z"
    };

    await expect(captureNativeStudioDraftRunSnapshot({
      projectRoot,
      configRoot,
      draft
    })).rejects.toMatchObject({ code: "studio_run_plan_resolution_invalid" });
  });
});
