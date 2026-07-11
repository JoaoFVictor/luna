import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { loadNativeRunContext } from "../../../src/platform/native/native-run-context.js";
import { loadStudioAgentCatalog } from "../../../src/studio/application/catalog/agent-catalog.js";

const temporaryDirectories: string[] = [];

async function agentsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-studio-agent-catalog-"));
  temporaryDirectories.push(root);
  const agents = path.join(root, "agents");
  await mkdir(agents);
  return agents;
}

async function writeAgent(
  root: string,
  id: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const directory = path.join(root, id);
  await mkdir(directory);
  const metadata = {
    id,
    description: `${id} description`,
    model_profile: "default",
    mode: "read_only",
    instructions_file: "instructions.md",
    output_schema: "output.schema.json",
    tools: ["tools.search"],
    runtime_requirements: ["reasoning"],
    ...overrides
  };
  await writeFile(
    path.join(directory, "agent.yaml"),
    Object.entries(metadata)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n") + "\n"
  );
  await writeFile(path.join(directory, "instructions.md"), `# ${id}\n`);
  await writeFile(
    path.join(directory, "output.schema.json"),
    `${JSON.stringify({ type: "object", additionalProperties: false }, null, 2)}\n`
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Studio agent catalog", () => {
  it("treats an absent optional agents root as an empty catalog", async () => {
    const root = await agentsRoot();
    const missing = path.join(root, "not-created");

    const catalog = await loadStudioAgentCatalog({
      agentsRoot: missing,
      capabilityRegistry: createCapabilityRegistry([])
    });

    expect(catalog).toMatchObject({
      status: "complete",
      agents: [],
      diagnostics: []
    });
  });

  it("loads validated agents without exposing local paths or instructions", async () => {
    const root = await agentsRoot();
    await writeAgent(root, "reviewer");

    const catalog = await loadStudioAgentCatalog({
      agentsRoot: root,
      capabilityRegistry: createCapabilityRegistry([])
    });

    expect(catalog.status).toBe("complete");
    expect(catalog.agents).toHaveLength(1);
    expect(catalog.agents[0]).toMatchObject({
      id: "reviewer",
      mode: "read_only",
      tools: ["tools.search"],
      runtime_requirements: ["reasoning"]
    });
    expect(catalog.agents[0]).not.toHaveProperty("directory");
    expect(catalog.agents[0]).not.toHaveProperty("instructions");
    expect(catalog.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("loads the repository's real agent catalog through the canonical loader", async () => {
    const root = path.resolve("agents");

    const catalog = await loadStudioAgentCatalog({
      agentsRoot: root,
      capabilityRegistry:
        nativeLunaPlatformRegistrations.capabilityRegistry
    });

    const repositoryAgents = [
      "architecture-reviewer",
      "code-implementer",
      "review-planner"
    ];
    const catalogAgentIds = catalog.agents.map((agent) => agent.id);

    expect(catalogAgentIds).toEqual(
      expect.arrayContaining(repositoryAgents)
    );
    expect(
      catalog.diagnostics.filter((diagnostic) =>
        repositoryAgents.includes(diagnostic.resource_id)
      )
    ).toEqual([]);
    expect(JSON.stringify(catalog)).not.toContain(root);
  });

  it("publishes the same agent revisions loaded by the real workflow runtime", async () => {
    const catalog = await loadStudioAgentCatalog({
      agentsRoot: path.resolve("agents"),
      capabilityRegistry:
        nativeLunaPlatformRegistrations.capabilityRegistry
    });
    const context = await loadNativeRunContext({
      projectRoot: path.resolve("."),
      configRoot: path.resolve("config"),
      target: { type: "workflow", id: "code-review" },
      invocation: {
        version: "2026-06",
        source: "github",
        event: "pull_request",
        repository: {
          provider: "github",
          owner: "example-org",
          name: "example-repo"
        }
      }
    });
    const catalogRevisions = new Map(
      catalog.agents.map((agent) => [agent.id, agent.revision])
    );

    expect(
      Object.entries(context.workflow.external_definition_digests)
    ).not.toHaveLength(0);
    for (const [reference, revision] of Object.entries(
      context.workflow.external_definition_digests
    )) {
      const match = /^agents\/([^/]+)\/agent\.yaml$/.exec(reference);
      expect(match?.[1]).toBeDefined();
      expect(revision).toBe(catalogRevisions.get(match?.[1] ?? ""));
      expect(revision).not.toBe("sha256:unresolved");
    }
  });

  it("projects an absolute in-root output schema as a relative reference", async () => {
    const root = await agentsRoot();
    const absoluteSchema = path.join(
      root,
      "reviewer",
      "output.schema.json"
    );
    await writeAgent(root, "reviewer", {
      output_schema: absoluteSchema
    });

    const catalog = await loadStudioAgentCatalog({
      agentsRoot: root,
      capabilityRegistry: createCapabilityRegistry([])
    });

    expect(catalog.status).toBe("complete");
    expect(catalog.agents[0]?.output_schema_reference).toBe(
      "output.schema.json"
    );
    expect(JSON.stringify(catalog)).not.toContain(root);
    expect(JSON.stringify(catalog)).not.toContain(absoluteSchema);
  });

  it("does not expose an absolute agent skill reference", async () => {
    const root = await agentsRoot();
    const absoluteSkill = path.join(root, "private", "SKILL.md");
    await writeAgent(root, "reviewer", { skills: [absoluteSkill] });

    const catalog = await loadStudioAgentCatalog({
      agentsRoot: root,
      capabilityRegistry: createCapabilityRegistry([])
    });

    expect(catalog.status).toBe("partial");
    expect(catalog.agents).toEqual([]);
    expect(catalog.diagnostics[0]).toMatchObject({
      code: "studio_catalog_reference_invalid",
      resource_id: "reviewer"
    });
    expect(JSON.stringify(catalog)).not.toContain(root);
    expect(JSON.stringify(catalog)).not.toContain(absoluteSkill);
  });

  it("projects repository skills used by real agents as project-relative references", async () => {
    const root = await agentsRoot();
    const skill = path.join(path.dirname(root), "skills", "review", "SKILL.md");
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, "# Review\n");
    await writeAgent(root, "reviewer", {
      skills: ["../../skills/review/SKILL.md"]
    });

    const catalog = await loadStudioAgentCatalog({
      agentsRoot: root,
      capabilityRegistry: createCapabilityRegistry([])
    });

    expect(catalog).toMatchObject({
      status: "complete",
      agents: [{ id: "reviewer", skills: ["skills/review/SKILL.md"] }],
      diagnostics: []
    });
    expect(JSON.stringify(catalog)).not.toContain(path.dirname(root));
  });

  it("keeps valid entries and reports invalid directories deterministically", async () => {
    const root = await agentsRoot();
    await writeAgent(root, "valid");
    await writeAgent(root, "broken", { id: "different" });

    const catalog = await loadStudioAgentCatalog({
      agentsRoot: root,
      capabilityRegistry: createCapabilityRegistry([])
    });

    expect(catalog.status).toBe("partial");
    expect(catalog.agents.map((agent) => agent.id)).toEqual(["valid"]);
    expect(catalog.diagnostics).toMatchObject([
      {
        severity: "error",
        code: "agent_id_mismatch",
        resource_kind: "agent",
        resource_id: "broken"
      }
    ]);
    expect(catalog.diagnostics[0]?.message).not.toContain(root);
  });

  it("does not follow symlinked catalog entries", async () => {
    const root = await agentsRoot();
    const outside = path.join(path.dirname(root), "outside-agent");
    await mkdir(outside);
    await symlink(outside, path.join(root, "linked"), "dir");

    const catalog = await loadStudioAgentCatalog({
      agentsRoot: root,
      capabilityRegistry: createCapabilityRegistry([])
    });

    expect(catalog.status).toBe("partial");
    expect(catalog.agents).toEqual([]);
    expect(catalog.diagnostics[0]).toMatchObject({
      code: "agent_catalog_entry_not_directory",
      resource_id: "linked"
    });
  });

  it("changes the technical fingerprint when instruction bytes change", async () => {
    const root = await agentsRoot();
    await writeAgent(root, "reviewer");
    const registry = createCapabilityRegistry([]);
    const before = await loadStudioAgentCatalog({
      agentsRoot: root,
      capabilityRegistry: registry
    });

    await writeFile(
      path.join(root, "reviewer", "instructions.md"),
      "# reviewer\nChanged\n"
    );
    const after = await loadStudioAgentCatalog({
      agentsRoot: root,
      capabilityRegistry: registry
    });

    expect(after.agents[0]?.revision).not.toBe(before.agents[0]?.revision);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});
