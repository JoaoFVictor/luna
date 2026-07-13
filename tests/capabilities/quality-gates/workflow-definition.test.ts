import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { manifest as agents } from "../../../src/capabilities/agents/manifest.js";
import { manifest as artifacts } from "../../../src/capabilities/artifacts/manifest.js";
import { manifest as context } from "../../../src/capabilities/context/manifest.js";
import { manifest as qualityGates } from "../../../src/capabilities/quality-gates/manifest.js";
import { manifest as localExec } from "../../../src/capabilities/local-exec/manifest.js";
import { manifest as reports } from "../../../src/capabilities/reports/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
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

function registryWithLocalExec() {
  return createCapabilityRegistry([
    agents,
    context,
    reports,
    artifacts,
    qualityGates,
    localExec
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
    "            - cmd: quality-check",
    "              args: [verify]",
    "          env_allowlist: []",
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

  it("rejects a dynamic review_agent because runtime agent projection is static", async () => {
    const root = await copyMinimumWorkflow();
    await writeGatedLoopWorkflow(root, [
      "  - id: implementation",
      "    type: pattern",
      "    uses: quality-gates.gated_agent_loop",
      "    worker: writer",
      "    after: [context]",
      "    gates:",
      "      - id: review",
      "        type: quality-gates.agent_review",
      "        input:",
      "          review_agent:",
      "            expression: \"$.invocation.reviewer\"",
      "          subject:",
      "            expression: \"$.gate\"",
      "        block_when:",
      "          expression: \"$.gate.decision = 'fail'\"",
      "    repair:",
      "      attempts: 0",
      ""
    ].join("\n"));

    await expect(loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_schema_invalid",
      path: "$.nodes[1].gates[0].input.review_agent",
      capability: "quality-gates.agent_review"
    });
  });

  it("validates read-only evidence built-ins and allows $.gate evidence inputs", async () => {
    const root = await copyMinimumWorkflow();
    await writeGatedLoopWorkflow(root, [
      "  - id: implementation",
      "    type: pattern",
      "    uses: quality-gates.gated_agent_loop",
      "    worker: writer",
      "    after: [context]",
      "    evidence:",
      "      - id: repository_context",
      "        uses: context.collect_context",
      "        input:",
      "          max_file_bytes:",
      "            expression: \"$.gate.diff_summary.max_file_bytes\"",
      "    gates:",
      "      - id: review",
      "        type: quality-gates.agent_review",
      "        input:",
      "          review_agent: writer",
      "          subject:",
      "            expression: \"$.gate.evidence.repository_context\"",
      "        block_when:",
      "          expression: \"$.gate.decision = 'fail'\"",
      "    repair:",
      "      attempts: 0",
      ""
    ].join("\n"));

    const definition = await loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    });

    expect(definition.graph.nodes[1]).toMatchObject({
      type: "pattern",
      evidence: [{ id: "repository_context", uses: "context.collect_context" }]
    });
    const compiled = compileWorkflow({ workflow: definition, registry: registry() });
    expect(compiled.nodes[1]).toMatchObject({
      kind: "pattern",
      evidence: [{
        id: "repository_context",
        node: {
          kind: "built_in",
          capability_id: "context.collect_context",
          yaml_path: "$.nodes[1].evidence[0]"
        }
      }]
    });
  });

  it("rejects evidence input that does not match the built-in schema", async () => {
    const root = await copyMinimumWorkflow();
    await writeGatedLoopWorkflow(root, [
      "  - id: implementation",
      "    type: pattern",
      "    uses: quality-gates.gated_agent_loop",
      "    worker: writer",
      "    after: [context]",
      "    evidence:",
      "      - id: repository_context",
      "        uses: context.collect_context",
      "        input:",
      "          max_file_bytes: invalid",
      "    gates:",
      "      - id: validation",
      "        type: quality-gates.validation_commands",
      "        input:",
      "          commands: []",
      "          env_allowlist: []",
      "          max_output_bytes: 2000",
      "    repair:",
      "      attempts: 0",
      ""
    ].join("\n"));

    await expect(loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_capability_config_invalid",
      path: "$.nodes[1].evidence[0].input",
      capability: "context.collect_context"
    });
  });

  it("forbids evidence built-ins that declare any side-effect policy", async () => {
    const root = await copyMinimumWorkflow();
    await writeGatedLoopWorkflow(root, [
      "  - id: implementation",
      "    type: pattern",
      "    uses: quality-gates.gated_agent_loop",
      "    worker: writer",
      "    after: [context]",
      "    evidence:",
      "      - id: command_context",
      "        uses: local-exec.command.read",
      "        input: {}",
      "    gates:",
      "      - id: validation",
      "        type: quality-gates.validation_commands",
      "        input:",
      "          commands: []",
      "          env_allowlist: []",
      "          max_output_bytes: 2000",
      "    repair:",
      "      attempts: 0",
      ""
    ].join("\n"));
    await patchWorkflow(root, (yaml) =>
      yaml.replace("  - quality-gates\n", "  - quality-gates\n  - local-exec\n")
    );

    await expect(loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registryWithLocalExec(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_side_effect_policy_invalid",
      path: "$.nodes[1].evidence[0].uses",
      capability: "local-exec.command.read"
    });
  });
});
