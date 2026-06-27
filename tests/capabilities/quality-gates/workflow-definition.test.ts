import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { manifest as agents } from "../../../src/capabilities/agents/manifest.js";
import { manifest as artifacts } from "../../../src/capabilities/artifacts/manifest.js";
import { manifest as context } from "../../../src/capabilities/context/manifest.js";
import { manifest as qualityGates } from "../../../src/capabilities/quality-gates/manifest.js";
import { manifest as reports } from "../../../src/capabilities/reports/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import {
  loadWorkflowDefinition,
  type DefinitionDigestResolver
} from "../../../src/core/workflow/definition.js";

const fixtures = path.join(process.cwd(), "tests/fixtures/workflows");
const finalReportNode = [
  "  - id: final_report",
  "    type: built_in",
  "    uses: reports.final_report",
  "    after: [context]",
  "    input:",
  "      sections:",
  "        - heading: Summary",
  "          content: ok",
  ""
].join("\n");

function registry() {
  return createCapabilityRegistry([
    agents,
    context,
    reports,
    artifacts,
    qualityGates
  ]);
}

function digestResolver(): DefinitionDigestResolver {
  return {
    async digestExternalDefinition(reference: string): Promise<string> {
      if (reference !== "agents/writer/agent.yaml") {
        throw new Error(`missing digest ${reference}`);
      }

      return "sha256:writer";
    }
  };
}

async function copyMinimumWorkflow(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-quality-gates-"));
  await cp(path.join(fixtures, "minimum"), path.join(root, "minimum"), {
    recursive: true
  });
  return root;
}

async function patchWorkflow(
  root: string,
  edit: (yaml: string) => string
): Promise<void> {
  const file = path.join(root, "minimum", "workflow.yaml");
  await writeFile(file, edit(await readFile(file, "utf8")));
}

function gatedLoopNode({
  repairAttempts,
  artifactSource
}: {
  repairAttempts: number;
  artifactSource?: string;
}): string {
  return [
    "  - id: implementation",
    "    type: pattern",
    "    uses: quality-gates.gated_agent_loop",
    "    worker: writer",
    "    after: [context]",
    "    gates:",
    "      - id: validation",
    "        type: quality-gates.validation_commands",
    "        input:",
    "          commands:",
    "            - cmd: npm",
    "              args: [test]",
    "          max_output_bytes: 2000",
    "    repair:",
    `      attempts: ${repairAttempts}`,
    ...(artifactSource === undefined
      ? []
      : [
          "    artifacts:",
          "      - path: implementation.json",
          "        publisher: artifacts.manifest_publisher",
          "        source:",
          `          expression: "${artifactSource}"`,
          "        format: json"
        ]),
    ""
  ].join("\n");
}

async function writeGatedLoopWorkflow(
  root: string,
  node: string
): Promise<void> {
  await patchWorkflow(root, (yaml) =>
    yaml
      .replace("  - artifacts\n", "  - artifacts\n  - agents\n  - quality-gates\n")
      .replace(finalReportNode, node)
  );
}

describe("quality-gates workflow definition", () => {
  it("publishes the gated agent loop authoring schema used by workflow YAML", () => {
    const pattern = qualityGates.patterns?.["quality-gates.gated_agent_loop"];

    expect(pattern?.input_schema).toMatchObject({
      required: ["worker", "gates"],
      properties: {
        worker: { type: "string" },
        gates: { type: "array" },
        repair: { type: "object" }
      }
    });
    expect(pattern?.input_schema).not.toMatchObject({
      properties: {
        writer_agent: expect.anything(),
        max_iterations: expect.anything()
      }
    });
  });

  it("requires gated agent loop artifact sources to read from the declaring node", async () => {
    const root = await copyMinimumWorkflow();
    await writeGatedLoopWorkflow(root, gatedLoopNode({
      repairAttempts: 1,
      artifactSource: "$.steps.context"
    }));

    await expect(loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_reference_unknown",
      path: "$.nodes[1].artifacts[0].source.expression",
      capability: "artifacts.manifest_publisher"
    });
  });

  it("validates static gated agent loop repair attempt bounds", async () => {
    const zeroRoot = await copyMinimumWorkflow();
    await writeGatedLoopWorkflow(zeroRoot, gatedLoopNode({ repairAttempts: 0 }));

    await expect(loadWorkflowDefinition(zeroRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).resolves.toMatchObject({
      graph: {
        nodes: [
          expect.any(Object),
          expect.objectContaining({
            id: "implementation",
            repair: { attempts: 0 }
          })
        ]
      }
    });

    const excessiveRoot = await copyMinimumWorkflow();
    await writeGatedLoopWorkflow(excessiveRoot, gatedLoopNode({ repairAttempts: 10 }));

    await expect(loadWorkflowDefinition(excessiveRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_schema_invalid",
      path: "$.nodes[1].repair.attempts",
      capability: "quality-gates.gated_agent_loop"
    });
  });
});
