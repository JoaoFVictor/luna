import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { manifest as agentsManifest } from "../../../src/capabilities/agents/manifest.js";
import { loadWorkflowDefinitionWithAgentDigests } from "../../../src/capabilities/agents/workflow-definition-loader.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { createAgentDefinitionDigestResolver } from "../../../src/capabilities/agents/definition-digest-resolver.js";

const roots: string[] = [];

async function writeAgent(): Promise<{
  root: string;
  directory: string;
  instructions: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-studio-agent-digest-"));
  roots.push(root);
  const directory = path.join(root, "reviewer");
  await mkdir(directory);
  await writeFile(
    path.join(directory, "agent.yaml"),
    [
      "id: reviewer",
      "description: Reviews changes",
      "model_profile: default",
      "mode: read_only",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      ""
    ].join("\n")
  );
  const instructions = path.join(directory, "instructions.md");
  await writeFile(instructions, "Review carefully.\n");
  await writeFile(
    path.join(directory, "output.schema.json"),
    '{"type":"object"}\n'
  );
  return { root, directory, instructions };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    )
  );
});

describe("agent definition digest resolver", () => {
  it("binds workflow revisions to the complete loaded agent definition", async () => {
    const fixture = await writeAgent();
    const resolver = createAgentDefinitionDigestResolver({
      agentsRoot: fixture.root,
      capabilityRegistry: createCapabilityRegistry([])
    });
    const before = await resolver.digestExternalDefinition(
      "agents/reviewer/agent.yaml"
    );

    await writeFile(fixture.instructions, "Review more carefully.\n");
    const after = await resolver.digestExternalDefinition(
      "agents/reviewer/agent.yaml"
    );

    expect(after).not.toBe(before);
  });

  it("changes when the resolved output schema changes", async () => {
    const fixture = await writeAgent();
    const resolver = createAgentDefinitionDigestResolver({
      agentsRoot: fixture.root,
      capabilityRegistry: createCapabilityRegistry([])
    });
    const before = await resolver.digestExternalDefinition(
      "agents/reviewer/agent.yaml"
    );

    await writeFile(
      path.join(fixture.directory, "output.schema.json"),
      '{"type":"object","required":["summary"]}\n'
    );
    const after = await resolver.digestExternalDefinition(
      "agents/reviewer/agent.yaml"
    );

    expect(after).not.toBe(before);
  });

  it("changes the owning workflow revision when agent bytes change", async () => {
    const fixture = await writeAgent();
    const workflowsRoot = path.join(fixture.root, "workflows");
    const workflowDirectory = path.join(workflowsRoot, "agent-run");
    await mkdir(workflowDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(workflowDirectory, "workflow.yaml"),
        [
          "id: agent-run",
          "type: workflow",
          "mode: read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "capabilities:",
          "  - agents",
          "nodes:",
          "  - id: review",
          "    type: agent",
          "    agent: reviewer",
          "    output_schema: output.schema.json",
          ""
        ].join("\n")
      ),
      writeFile(
        path.join(workflowDirectory, "input.schema.json"),
        '{"type":"object"}\n'
      ),
      writeFile(
        path.join(workflowDirectory, "output.schema.json"),
        '{"type":"object"}\n'
      )
    ]);
    const options = {
      agentsRoot: fixture.root,
      capabilityRegistry: createCapabilityRegistry([agentsManifest])
    };
    const before = await loadWorkflowDefinitionWithAgentDigests(
      workflowsRoot,
      "agent-run",
      options
    );

    await writeFile(fixture.instructions, "Review with changed guidance.\n");
    const after = await loadWorkflowDefinitionWithAgentDigests(
      workflowsRoot,
      "agent-run",
      options
    );

    expect(after.external_definition_digests).not.toEqual(
      before.external_definition_digests
    );
    expect(after.revision).not.toBe(before.revision);
  });

  it("does not bind revisions to absolute host paths inside the agent", async () => {
    const first = await writeAgent();
    const second = await writeAgent();
    for (const fixture of [first, second]) {
      await writeFile(
        path.join(fixture.directory, "agent.yaml"),
        [
          "id: reviewer",
          "description: Reviews changes",
          "model_profile: default",
          "mode: read_only",
          `instructions_file: ${JSON.stringify(path.join(fixture.directory, "instructions.md"))}`,
          `output_schema: ${JSON.stringify(path.join(fixture.directory, "output.schema.json"))}`,
          ""
        ].join("\n")
      );
    }
    const firstResolver = createAgentDefinitionDigestResolver({
      agentsRoot: first.root,
      capabilityRegistry: createCapabilityRegistry([])
    });
    const secondResolver = createAgentDefinitionDigestResolver({
      agentsRoot: second.root,
      capabilityRegistry: createCapabilityRegistry([])
    });

    await expect(
      firstResolver.digestExternalDefinition("agents/reviewer/agent.yaml")
    ).resolves.toBe(
      await secondResolver.digestExternalDefinition(
        "agents/reviewer/agent.yaml"
      )
    );
  });

  it.each([
    "agents/../agent.yaml",
    "agents/reviewer/instructions.md",
    "/agents/reviewer/agent.yaml"
  ])("rejects unsupported external reference %s", async (reference) => {
    const fixture = await writeAgent();
    const resolver = createAgentDefinitionDigestResolver({
      agentsRoot: fixture.root,
      capabilityRegistry: createCapabilityRegistry([])
    });

    await expect(resolver.digestExternalDefinition(reference)).rejects.toMatchObject({
      code: "agent_external_definition_reference_invalid"
    });
  });
});
