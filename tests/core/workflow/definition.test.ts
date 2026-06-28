import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { capabilityManifest, type CapabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { manifest as agents } from "../../../src/capabilities/agents/manifest.js";
import { manifest as artifacts } from "../../../src/capabilities/artifacts/manifest.js";
import { manifest as context } from "../../../src/capabilities/context/manifest.js";
import { manifest as qualityGates } from "../../../src/capabilities/quality-gates/manifest.js";
import { manifest as reports } from "../../../src/capabilities/reports/manifest.js";
import { loadWorkflowDefinition, type DefinitionDigestResolver } from "../../../src/core/workflow/definition.js";

const fixtures = path.join(process.cwd(), "tests/fixtures/workflows");

function registry(overrides: Record<string, CapabilityManifest> = {}) {
  return createCapabilityRegistry([
    agents,
    context,
    reports,
    artifacts,
    qualityGates,
    ...Object.values(overrides)
  ]);
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
const strictTestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["flag"],
  properties: {
    flag: { type: "boolean" }
  }
} as const;
const boundedTestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["count"],
  properties: {
    count: { type: "integer", minimum: 2, maximum: 4 }
  }
} as const;

const decisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision"],
  properties: {
    decision: { enum: ["yes", "no"] }
  }
} as const;

const testCapability = capabilityManifest({
  id: "test-cap",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "test-cap.bounded_builtin": {
      id: "test-cap.bounded_builtin",
      input_schema: boundedTestSchema,
      output_schema: boundedTestSchema,
      required_ports: []
    }
  },
  gates: {
    "test-cap.shadow_gate": {
      id: "test-cap.shadow_gate",
      input_schema: { type: "object", additionalProperties: false },
      decision_schema: decisionSchema,
      output_schema: strictTestSchema,
      local_context_roots: ["$.steps"],
      interrupt: "none"
    }
  },
  patterns: {
    "test-cap.strict_pattern": {
      id: "test-cap.strict_pattern",
      declaring_node_type: "pattern",
      input_schema: strictTestSchema,
      output_schema: strictTestSchema,
      expand: { type: "declaring_node_subgraph" }
    }
  }
});

function registryWithTestCapability() {
  return registry({ "test-cap": testCapability });
}

describe("strict workflow definition validation", () => {
  it("loads a valid minimum workflow and computes a deterministic revision", async () => {
    const root = await copyWorkflowFixture("minimum");
    const options = { capabilityRegistry: registry(), digestResolver: digestResolver() };

    const first = await loadWorkflowDefinition(root, "minimum", options);
    const second = await loadWorkflowDefinition(root, "minimum", options);

    expect(first.id).toBe("minimum");
    expect(first.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.revision).toBe(first.revision);
  });

  it("changes revision when external definition digests change", async () => {
    const root = await copyWorkflowFixture("minimum");

    await patchWorkflow(root, "minimum", (yaml) =>
      yaml.replace(
        "type: built_in\n    uses: context.collect_context",
        "type: agent\n    agent: reviewer\n    output_schema: output.schema.json"
      ).replace("  - artifacts\n", "  - artifacts\n  - agents\n")
    );
    await mkdir(path.join(root, "agents", "reviewer"), { recursive: true });
    const agentSchema = path.join(root, "agents", "reviewer", "output.schema.json");
    await writeFile(agentSchema, JSON.stringify({ type: "object", additionalProperties: true }));
    const agentDigestA = await loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver({ "agents/reviewer/agent.yaml": "sha256:a" })
    });
    const agentDigestB = await loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver({ "agents/reviewer/agent.yaml": "sha256:b" })
    });
    expect(agentDigestB.revision).not.toBe(agentDigestA.revision);
  });

  it("rejects missing declared capabilities with YAML paths", async () => {
    const capabilityRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(capabilityRoot, "minimum", (yaml) =>
      yaml.replace("  - context\n", "")
    );
    await expect(
      loadWorkflowDefinition(capabilityRoot, "minimum", {
        capabilityRegistry: registry(),
        digestResolver: digestResolver()
      })
    ).rejects.toMatchObject({
      code: "workflow_capability_missing",
      capability: "context"
    });
  });

});

async function loopWorkflowRoot(options: {
  gateType?: string;
  capabilities?: string;
} = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-workflows-"));
  const dir = path.join(root, "loop");
  await mkdir(dir);
  await writeFile(path.join(dir, "input.schema.json"), "{\"type\":\"object\"}\n");
  await writeFile(path.join(dir, "output.schema.json"), "{\"type\":\"object\"}\n");
  await writeFile(
    path.join(dir, "workflow.yaml"),
    `id: loop
type: workflow
input_schema: input.schema.json
output_schema: output.schema.json
${options.capabilities ?? "capabilities: [quality-gates, agents, test-cap]"}
nodes:
  - id: loop
    type: pattern
    uses: quality-gates.gated_agent_loop
    worker: writer
    gates:
      - id: review
        type: ${options.gateType ?? "test-cap.strict_gate"}
        input:
          flag: true
          subject:
            expression: "$.gate.output"
    repair:
      attempts: 2
`
  );
  return root;
}

async function patternWorkflowRoot(
  uses: string,
  capability: string
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-workflows-"));
  const dir = path.join(root, "patterned");
  await mkdir(dir);
  await writeFile(path.join(dir, "input.schema.json"), "{\"type\":\"object\"}\n");
  await writeFile(path.join(dir, "output.schema.json"), "{\"type\":\"object\"}\n");
  await writeFile(
    path.join(dir, "workflow.yaml"),
    `id: patterned
type: workflow
input_schema: input.schema.json
output_schema: output.schema.json
capabilities: [${capability}]
nodes:
  - id: pattern
    type: pattern
    uses: ${uses}
`
  );
  return root;
}
