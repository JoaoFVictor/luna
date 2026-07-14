import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentDefinition } from "../../../src/capabilities/agents/agent-loader.js";
import { resolveEffectiveSkillReferences } from "../../../src/core/skills/definition.js";
import {
  captureNativeStudioDraftRunSnapshot,
  captureNativeStudioRunSnapshot,
  withMaterializedNativeStudioRunSnapshot
} from "../../../src/studio/adapters/native/run-definition-snapshot.js";
import type { StudioDraftItem } from "../../../src/studio/contracts/draft-authoring.js";

const roots: string[] = [];
const schema = '{"type":"object","additionalProperties":true}\n';
const originalSkill = [
  "---",
  "name: safe-implementation",
  "description: Keep implementation changes safe.",
  "---",
  "",
  "Original pinned guidance.",
  ""
].join("\n");

async function writeInstalledSkillFixture(skillPath: string): Promise<{
  projectRoot: string;
  configRoot: string;
  skillFile: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "luna-run-agent-skill-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  const configRoot = path.join(root, "config");
  const workflowRoot = path.join(projectRoot, "workflows", "skill-flow");
  const agentRoot = path.join(projectRoot, "agents", "implementer");
  const skillFile = path.join(projectRoot, "skills", "safe", "SKILL.md");
  await Promise.all([
    mkdir(workflowRoot, { recursive: true }),
    mkdir(agentRoot, { recursive: true }),
    mkdir(path.dirname(skillFile), { recursive: true }),
    mkdir(configRoot, { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(workflowRoot, "workflow.yaml"), [
      "id: skill-flow",
      "type: workflow",
      "mode: trusted_local_write",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "capabilities: []",
      "nodes:",
      "  - id: implement",
      "    type: agent",
      "    agent: implementer",
      "    output_schema: output.schema.json",
      "    input: {}",
      ""
    ].join("\n"), "utf8"),
    writeFile(path.join(workflowRoot, "input.schema.json"), schema, "utf8"),
    writeFile(path.join(workflowRoot, "output.schema.json"), schema, "utf8"),
    writeFile(path.join(agentRoot, "agent.yaml"), [
      "id: implementer",
      "description: Implements a task.",
      "model_profile: deep",
      "mode: trusted_local_write",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      "skills:",
      `  - ${skillPath}`,
      ""
    ].join("\n"), "utf8"),
    writeFile(path.join(agentRoot, "instructions.md"), "Implement safely.\n", "utf8"),
    writeFile(path.join(agentRoot, "output.schema.json"), schema, "utf8"),
    writeFile(skillFile, originalSkill, "utf8")
  ]);
  return { projectRoot, configRoot, skillFile };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Studio run definition snapshot", () => {
  it("pins external agent skills in installed workflow snapshots", async () => {
    const fixture = await writeInstalledSkillFixture(
      "../../skills/safe/SKILL.md"
    );

    const first = await captureNativeStudioRunSnapshot({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      workflowId: "skill-flow"
    });
    await writeFile(
      fixture.skillFile,
      originalSkill.replace("Original pinned guidance.", "Changed guidance."),
      "utf8"
    );
    const second = await captureNativeStudioRunSnapshot({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      workflowId: "skill-flow"
    });

    expect(first.bundle_hash).not.toBe(second.bundle_hash);
    expect(
      first.files.find((file) => file.path === "skills/safe/SKILL.md")
        ?.content.toString()
    ).toBe(originalSkill);
    await withMaterializedNativeStudioRunSnapshot(first, async ({ projectRoot }) => {
      await expect(
        readFile(path.join(projectRoot, "skills", "safe", "SKILL.md"), "utf8")
      ).resolves.toBe(originalSkill);
      const agent = await loadAgentDefinition(
        path.join(projectRoot, "agents"),
        "implementer"
      );
      const skills = await resolveEffectiveSkillReferences({
        agentDirectory: agent.directory,
        agentSkills: agent.skills
      });
      expect(skills).toMatchObject([{
        requestedPath: "../../skills/safe/SKILL.md",
        content: originalSkill
      }]);
    });
  });

  it("rejects agent skill paths that escape the snapshot project root", async () => {
    const fixture = await writeInstalledSkillFixture(
      "../../../outside/SKILL.md"
    );

    await expect(captureNativeStudioRunSnapshot({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      workflowId: "skill-flow"
    })).rejects.toMatchObject({ code: "studio_run_plan_resolution_invalid" });
  });

  it("rejects symbolic links used as external agent skills", async () => {
    const fixture = await writeInstalledSkillFixture(
      "../../skills/safe/SKILL.md"
    );
    const target = path.join(fixture.projectRoot, "physical-skill.md");
    await Promise.all([
      rm(fixture.skillFile),
      writeFile(target, originalSkill, "utf8")
    ]);
    await symlink(target, fixture.skillFile);

    await expect(captureNativeStudioRunSnapshot({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      workflowId: "skill-flow"
    })).rejects.toMatchObject({ code: "studio_run_plan_resolution_invalid" });
  });

  it("captures an installed composed workflow used by a saved draft", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "luna-run-subworkflow-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    const configRoot = path.join(root, "config");
    const childRoot = path.join(projectRoot, "workflows", "child-flow");
    const grandchildRoot = path.join(projectRoot, "workflows", "grandchild-flow");
    const agentRoot = path.join(projectRoot, "agents", "nested-implementer");
    const skillRoot = path.join(projectRoot, "skills", "nested-safe");
    await Promise.all([
      mkdir(childRoot, { recursive: true }),
      mkdir(grandchildRoot, { recursive: true }),
      mkdir(agentRoot, { recursive: true }),
      mkdir(skillRoot, { recursive: true }),
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
        "nodes:",
        "  - id: implement",
        "    type: agent",
        "    agent: nested-implementer",
        "    output_schema: output.schema.json",
        "    input: {}",
        ""
      ].join("\n"), "utf8"),
      writeFile(path.join(grandchildRoot, "input.schema.json"), schema, "utf8"),
      writeFile(path.join(grandchildRoot, "output.schema.json"), schema, "utf8"),
      writeFile(path.join(agentRoot, "agent.yaml"), [
        "id: nested-implementer",
        "description: Implements nested work.",
        "model_profile: deep",
        "mode: trusted_local_write",
        "instructions_file: instructions.md",
        "output_schema: output.schema.json",
        "skills:",
        "  - ../../skills/nested-safe/SKILL.md",
        ""
      ].join("\n"), "utf8"),
      writeFile(path.join(agentRoot, "instructions.md"), "Implement safely.\n", "utf8"),
      writeFile(path.join(agentRoot, "output.schema.json"), schema, "utf8"),
      writeFile(path.join(skillRoot, "SKILL.md"), originalSkill, "utf8")
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
        "project/workflows/grandchild-flow/output.schema.json",
        "project/skills/nested-safe/SKILL.md"
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
