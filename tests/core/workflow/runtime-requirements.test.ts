import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { manifest as agents } from "../../../src/capabilities/agents/manifest.js";
import { manifest as artifacts } from "../../../src/capabilities/artifacts/manifest.js";
import { manifest as context } from "../../../src/capabilities/context/manifest.js";
import { manifest as reports } from "../../../src/capabilities/reports/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { loadWorkflowDefinition, type DefinitionDigestResolver } from "../../../src/core/workflow/definition.js";

const fixtures = path.join(process.cwd(), "tests/fixtures/workflows");

function registry() {
  return createCapabilityRegistry([agents, context, reports, artifacts]);
}

function digestResolver(digests: Record<string, string> = {}): DefinitionDigestResolver {
  return {
    async digestExternalDefinition(reference: string): Promise<string> {
      const digest = digests[reference];
      if (!digest) {
        throw new Error(`missing digest ${reference}`);
      }
      return digest;
    }
  };
}

async function copyWorkflowFixture(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-workflows-"));
  await cp(path.join(fixtures, name), path.join(root, name), { recursive: true });
  return root;
}

async function patchWorkflow(
  root: string,
  workflowId: string,
  edit: (yaml: string) => string
): Promise<void> {
  const file = path.join(root, workflowId, "workflow.yaml");
  await writeFile(file, edit(await readFile(file, "utf8")));
}

function agentNodeYaml(runtimeRequirements: readonly string[]): string {
  return [
    "type: agent",
    "    agent: reviewer",
    "    output_schema: output.schema.json",
    "    runtime_requirements:",
    ...runtimeRequirements.map((requirement) => `      - ${requirement}`)
  ].join("\n");
}

async function patchMinimumAgentWorkflow(
  runtimeRequirements: readonly string[]
): Promise<string> {
  const root = await copyWorkflowFixture("minimum");
  const agentRoot = path.join(root, "agents", "reviewer");
  await mkdir(agentRoot, { recursive: true });
  await writeFile(
    path.join(agentRoot, "output.schema.json"),
    JSON.stringify({ type: "object", additionalProperties: true })
  );

  await patchWorkflow(root, "minimum", (yaml) =>
    yaml.replace("  - artifacts\n", "  - artifacts\n  - agents\n").replace(
      "type: built_in\n    uses: context.collect_context",
      agentNodeYaml(runtimeRequirements)
    )
  );

  return root;
}

describe("workflow agent runtime requirements", () => {
  it("parses runtime requirements without accepting runtime-specific options", async () => {
    const root = await patchMinimumAgentWorkflow(["tool_calling", "mcp_tools"]);

    const workflow = await loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver({ "agents/reviewer/agent.yaml": "sha256:reviewer" })
    });

    expect(workflow.graph.nodes[0]).toMatchObject({
      type: "agent",
      runtime_requirements: ["tool_calling", "mcp_tools"]
    });
  });

  it("preserves custom runtime requirements for runtime capability negotiation", async () => {
    const root = await patchMinimumAgentWorkflow(["runtime_magic"]);

    const workflow = await loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver({ "agents/reviewer/agent.yaml": "sha256:reviewer" })
    });

    expect(workflow.graph.nodes[0]).toMatchObject({
      type: "agent",
      runtime_requirements: ["runtime_magic"]
    });
  });
});
