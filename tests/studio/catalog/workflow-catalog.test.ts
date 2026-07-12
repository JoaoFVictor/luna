import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { loadStudioWorkflowCatalog } from "../../../src/studio/application/catalog/workflow-catalog.js";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-studio-workflows-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeMinimalWorkflow(root: string, id: string): Promise<void> {
  const directory = path.join(root, id);
  await mkdir(directory);
  await writeFile(
    path.join(directory, "workflow.yaml"),
    [
      `id: ${id}`,
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "capabilities: []",
      "nodes: []",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(directory, "input.schema.json"),
    '{"type":"object"}\n'
  );
  await writeFile(
    path.join(directory, "output.schema.json"),
    '{"type":"object"}\n'
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Studio workflow catalog", () => {
  it("loads the repository workflows with the effective platform registry", async () => {
    const catalog = await loadStudioWorkflowCatalog({
      workflowsRoot: path.resolve("workflows"),
      loadOptions: {
        agentsRoot: path.resolve("agents"),
        capabilityRegistry:
          nativeLunaPlatformRegistrations.capabilityRegistry
      }
    });

    expect(catalog.status).toBe("complete");
    expect(catalog.workflows.length).toBeGreaterThan(0);
    expect(catalog.workflows.some((workflow) => workflow.id === "code-review"))
      .toBe(true);
    expect(
      catalog.workflows.find((workflow) => workflow.id === "code-review")?.agents
    ).toEqual([
      "architecture-reviewer",
      "change-acceptance-reviewer",
      "change-reviewer",
      "review-planner",
      "security-reviewer"
    ]);
  });

  it("projects absolute in-root schema paths as relative references", async () => {
    const root = await temporaryRoot();
    await writeMinimalWorkflow(root, "absolute-schemas");
    const directory = path.join(root, "absolute-schemas");
    const inputSchema = path.join(directory, "input.schema.json");
    const outputSchema = path.join(directory, "output.schema.json");
    const configSchema = path.join(directory, "config.schema.json");
    await writeFile(configSchema, '{"type":"object"}\n');
    await writeFile(
      path.join(directory, "workflow.yaml"),
      [
        "id: absolute-schemas",
        "type: workflow",
        "mode: read_only",
        `input_schema: ${JSON.stringify(inputSchema)}`,
        `output_schema: ${JSON.stringify(outputSchema)}`,
        "config:",
        "  file: local.yaml",
        `  schema: ${JSON.stringify(configSchema)}`,
        "capabilities: []",
        "nodes: []",
        ""
      ].join("\n")
    );

    const catalog = await loadStudioWorkflowCatalog({
      workflowsRoot: root,
      loadOptions: {
        agentsRoot: path.join(path.dirname(root), "agents"),
        capabilityRegistry: createCapabilityRegistry([])
      }
    });

    expect(catalog.status).toBe("complete");
    expect(catalog.workflows[0]).toMatchObject({
      input_schema: "input.schema.json",
      output_schema: "output.schema.json",
      input_schema_content: { type: "object" },
      output_schema_content: { type: "object" },
      config: {
        file: "local.yaml",
        schema: "config.schema.json"
      }
    });
    expect(JSON.stringify(catalog)).not.toContain(root);
    expect(JSON.stringify(catalog)).not.toContain(inputSchema);
    expect(JSON.stringify(catalog)).not.toContain(outputSchema);
    expect(JSON.stringify(catalog)).not.toContain(configSchema);
  });

  it("keeps valid workflows visible when another entry is invalid", async () => {
    const root = await temporaryRoot();
    await writeMinimalWorkflow(root, "valid");
    await mkdir(path.join(root, "broken"));
    await writeFile(path.join(root, "broken", "workflow.yaml"), "id: [\n");

    const catalog = await loadStudioWorkflowCatalog({
      workflowsRoot: root,
      loadOptions: {
        agentsRoot: path.join(path.dirname(root), "agents"),
        capabilityRegistry: createCapabilityRegistry([])
      }
    });

    expect(catalog.status).toBe("partial");
    expect(catalog.workflows.map((workflow) => workflow.id)).toEqual(["valid"]);
    expect(catalog.diagnostics[0]).toMatchObject({
      resource_kind: "workflow",
      resource_id: "broken"
    });
    expect(catalog.diagnostics[0]?.message).not.toContain(root);
  });

  it("projects authoritative synchronous-composition posture for the resolved tree", async () => {
    const root = await temporaryRoot();
    await writeMinimalWorkflow(root, "leaf");
    await writeMinimalWorkflow(root, "nested-safe");
    await writeFile(path.join(root, "nested-safe", "workflow.yaml"), [
      "id: nested-safe",
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "capabilities: []",
      "nodes:",
      "  - id: leaf",
      "    type: workflow",
      "    workflow: leaf",
      "    input: {}",
      ""
    ].join("\n"));
    await writeMinimalWorkflow(root, "approval");
    await writeFile(path.join(root, "approval", "workflow.yaml"), [
      "id: approval",
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "capabilities: [hitl]",
      "nodes:",
      "  - id: approve",
      "    type: human_gate",
      "    uses: hitl.approval",
      ""
    ].join("\n"));

    const catalog = await loadStudioWorkflowCatalog({
      workflowsRoot: root,
      loadOptions: {
        agentsRoot: path.join(path.dirname(root), "agents"),
        capabilityRegistry: nativeLunaPlatformRegistrations.capabilityRegistry
      }
    });

    expect(catalog.workflows.find((workflow) => workflow.id === "nested-safe"))
      .toMatchObject({
        node_counts: { workflow: 1 },
        synchronous_composition: "allowed"
      });
    expect(catalog.workflows.find((workflow) => workflow.id === "approval"))
      .toMatchObject({
        synchronous_composition: "blocked",
        synchronous_composition_blocked_reason: "human_input"
      });
  });

  it("does not follow symlinked workflow entries", async () => {
    const root = await temporaryRoot();
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
    await mkdir(outside);
    temporaryDirectories.push(outside);
    await symlink(outside, path.join(root, "linked"), "dir");

    const catalog = await loadStudioWorkflowCatalog({
      workflowsRoot: root,
      loadOptions: {
        agentsRoot: path.join(path.dirname(root), "agents"),
        capabilityRegistry: createCapabilityRegistry([])
      }
    });

    expect(catalog.status).toBe("partial");
    expect(catalog.diagnostics[0]).toMatchObject({
      code: "workflow_catalog_entry_not_directory",
      resource_id: "linked"
    });
  });
});
