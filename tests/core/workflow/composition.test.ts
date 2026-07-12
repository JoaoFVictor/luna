import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflowDefinition } from "../../../src/core/workflow/definition.js";

async function writeWorkflow(
  root: string,
  id: string,
  options: {
    readonly mode?: "read_only" | "trusted_local_write";
    readonly requiresRepository?: boolean;
    readonly nodes: string;
    readonly inputSchema?: unknown;
    readonly outputSchema?: unknown;
    readonly capabilities?: readonly string[];
  }
): Promise<void> {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "input.schema.json"),
    JSON.stringify(options.inputSchema ?? { type: "object" })
  );
  await writeFile(
    path.join(directory, "output.schema.json"),
    JSON.stringify(options.outputSchema ?? { type: "object" })
  );
  await writeFile(path.join(directory, "workflow.yaml"), [
    `id: ${id}`,
    "type: workflow",
    `mode: ${options.mode ?? "read_only"}`,
    "input_schema: input.schema.json",
    "output_schema: output.schema.json",
    `capabilities: [${(options.capabilities ?? []).join(", ")}]`,
    ...(options.requiresRepository ? ["requires:", "  repository: true"] : []),
    ...(options.nodes === "[]" ? ["nodes: []"] : ["nodes:", options.nodes]),
    ""
  ].join("\n"));
}

describe("workflow composition definitions", () => {
  it("pins a resolved child revision and validates the child input schema", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-composition-"));
    await writeWorkflow(root, "child", {
      nodes: "  - id: done\n    type: workflow\n    workflow: leaf\n    input: {}",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string" } }
      }
    });
    await writeWorkflow(root, "leaf", { nodes: "[]" });
    await writeWorkflow(root, "parent", {
      nodes: "  - id: call\n    type: workflow\n    workflow: child\n    input:\n      name: Luna"
    });

    const definition = await loadWorkflowDefinition(root, "parent");
    expect(definition.compositions?.child.id).toBe("child");
    expect(definition.external_definition_digests)
      .toMatchObject({ "workflows/child/workflow.yaml": definition.compositions?.child.revision });

    await writeWorkflow(root, "parent-invalid", {
      nodes: "  - id: call\n    type: workflow\n    workflow: child\n    input: {}"
    });
    await expect(loadWorkflowDefinition(root, "parent-invalid")).rejects.toMatchObject({
      code: "workflow_capability_config_invalid",
      path: "$.nodes[0].input"
    });
  });

  it("rejects missing references and recursive composition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-composition-"));
    await writeWorkflow(root, "missing-parent", {
      nodes: "  - id: call\n    type: workflow\n    workflow: absent\n    input: {}"
    });
    await expect(loadWorkflowDefinition(root, "missing-parent")).rejects.toMatchObject({
      code: "workflow_external_definition_missing"
    });

    await writeWorkflow(root, "first", {
      nodes: "  - id: second\n    type: workflow\n    workflow: second\n    input: {}"
    });
    await writeWorkflow(root, "second", {
      nodes: "  - id: first\n    type: workflow\n    workflow: first\n    input: {}"
    });
    await expect(loadWorkflowDefinition(root, "first")).rejects.toMatchObject({
      code: "workflow_composition_cycle"
    });
  });

  it("rejects authority escalation and composed HITL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-composition-"));
    await writeWorkflow(root, "writer", {
      mode: "trusted_local_write",
      nodes: "[]"
    });
    await writeWorkflow(root, "reader", {
      nodes: "  - id: writer\n    type: workflow\n    workflow: writer\n    input: {}"
    });
    await expect(loadWorkflowDefinition(root, "reader")).rejects.toMatchObject({
      code: "workflow_composition_mode_invalid"
    });

    await writeWorkflow(root, "repository-child", {
      requiresRepository: true,
      nodes: "[]"
    });
    await writeWorkflow(root, "no-authority", {
      nodes: "  - id: child\n    type: workflow\n    workflow: repository-child\n    input: {}"
    });
    await expect(loadWorkflowDefinition(root, "no-authority")).rejects.toMatchObject({
      code: "workflow_composition_requirement_missing"
    });

    await writeWorkflow(root, "approval", {
      capabilities: ["hitl"],
      nodes: "  - id: approve\n    type: human_gate\n    uses: hitl.approval"
    });
    await writeWorkflow(root, "hitl-parent", {
      nodes: "  - id: approval\n    type: workflow\n    workflow: approval\n    input: {}"
    });
    await expect(loadWorkflowDefinition(root, "hitl-parent")).rejects.toMatchObject({
      code: "workflow_composition_interrupt_unsupported"
    });
  });

  it("memoizes a shared child across a composition diamond", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-composition-"));
    await writeWorkflow(root, "shared", { nodes: "[]" });
    for (const id of ["left", "right"]) {
      await writeWorkflow(root, id, {
        nodes: "  - id: shared\n    type: workflow\n    workflow: shared\n    input: {}"
      });
    }
    await writeWorkflow(root, "diamond", {
      nodes: [
        "  - id: left",
        "    type: workflow",
        "    workflow: left",
        "    input: {}",
        "  - id: right",
        "    type: workflow",
        "    workflow: right",
        "    input: {}"
      ].join("\n")
    });

    const definition = await loadWorkflowDefinition(root, "diamond");
    expect(definition.compositions?.left.compositions?.shared).toBe(
      definition.compositions?.right.compositions?.shared
    );
  });
});
