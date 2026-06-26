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

const strictGateInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["flag"],
  properties: {
    flag: { type: "boolean" },
    subject: { description: "Gate subject may be an expression." }
  }
} as const;

const testCapability = capabilityManifest({
  id: "test-cap",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "test-cap.strict_builtin": {
      id: "test-cap.strict_builtin",
      input_schema: strictTestSchema,
      output_schema: strictTestSchema,
      required_ports: []
    },
    "test-cap.bounded_builtin": {
      id: "test-cap.bounded_builtin",
      input_schema: boundedTestSchema,
      output_schema: boundedTestSchema,
      required_ports: []
    }
  },
  gates: {
    "test-cap.strict_gate": {
      id: "test-cap.strict_gate",
      input_schema: strictGateInputSchema,
      decision_schema: decisionSchema,
      output_schema: strictTestSchema,
      local_context_roots: ["$.gate"],
      interrupt: "none"
    },
    "test-cap.shadow_gate": {
      id: "test-cap.shadow_gate",
      input_schema: { type: "object", additionalProperties: false },
      decision_schema: decisionSchema,
      output_schema: strictTestSchema,
      local_context_roots: ["$.steps"],
      interrupt: "none"
    }
  },
  policies: {
    "test-cap.strict_policy": {
      id: "test-cap.strict_policy",
      config_schema: strictTestSchema,
      local_context_roots: ["$.policy"]
    }
  },
  artifact_publishers: {
    "test-cap.strict_publisher": {
      id: "test-cap.strict_publisher",
      source_node_ownership: "declaring_node",
      path_policy: "declared_path",
      overwrite_policy: "forbid",
      config_schema: strictTestSchema,
      manifest_transaction: "required"
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
    expect(first.graph.nodes.map((node) => node.id)).toEqual([
      "context",
      "final_report"
    ]);
  });

  it("changes revision when YAML, schema content, capability versions, or external definition digests change", async () => {
    const root = await copyWorkflowFixture("minimum");
    const base = await loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    });

    await patchWorkflow(root, "minimum", (yaml) =>
      yaml.replace("content: ok", "content: changed")
    );
    const yamlChanged = await loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    });
    expect(yamlChanged.revision).not.toBe(base.revision);

    await writeFile(
      path.join(root, "minimum", "output.schema.json"),
      "{\n  \"type\": \"object\",\n  \"additionalProperties\": false,\n  \"properties\": { \"changed\": { \"type\": \"boolean\" } }\n}\n"
    );
    const schemaChanged = await loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    });
    expect(schemaChanged.revision).not.toBe(yamlChanged.revision);

    const versionChanged = await loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: createCapabilityRegistry([
        { ...context, version: "2026.06.26" },
        reports,
        artifacts,
        qualityGates
      ]),
      digestResolver: digestResolver()
    });
    expect(versionChanged.revision).not.toBe(schemaChanged.revision);

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

  it("rejects unknown fields, duplicate ids, missing schemas, and missing declared capabilities with YAML paths", async () => {
    const root = await copyWorkflowFixture("minimum");
    await patchWorkflow(root, "minimum", (yaml) => `${yaml}\nextra: nope\n`);
    await expect(
      loadWorkflowDefinition(root, "minimum", {
        capabilityRegistry: registry(),
        digestResolver: digestResolver()
      })
    ).rejects.toMatchObject({
      code: "workflow_unknown_field",
      path: "$.extra"
    });

    await rm(root, { recursive: true, force: true });
    const duplicateRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(duplicateRoot, "minimum", (yaml) =>
      yaml.replace("id: final_report", "id: context")
    );
    await expect(
      loadWorkflowDefinition(duplicateRoot, "minimum", {
        capabilityRegistry: registry(),
        digestResolver: digestResolver()
      })
    ).rejects.toMatchObject({ code: "workflow_node_duplicate", path: "$.nodes[1].id" });

    const schemaRoot = await copyWorkflowFixture("minimum");
    await rm(path.join(schemaRoot, "minimum", "output.schema.json"));
    await expect(
      loadWorkflowDefinition(schemaRoot, "minimum", {
        capabilityRegistry: registry(),
        digestResolver: digestResolver()
      })
    ).rejects.toMatchObject({ code: "workflow_schema_missing" });

    const escapedSchemaRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(escapedSchemaRoot, "minimum", (yaml) =>
      yaml.replace("input_schema: input.schema.json", "input_schema: ../outside.schema.json")
    );
    await expect(
      loadWorkflowDefinition(escapedSchemaRoot, "minimum", {
        capabilityRegistry: registry(),
        digestResolver: digestResolver()
      })
    ).rejects.toMatchObject({ code: "workflow_path_escape" });

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

  it("rejects legacy graph keys and invalid top-level metadata", async () => {
    const graphRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(graphRoot, "minimum", (yaml) => `${yaml}\ngraph: graph.yaml\n`);
    await expect(loadWorkflowDefinition(graphRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({ code: "workflow_unknown_field", path: "$.graph" });

    const modeRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(modeRoot, "minimum", (yaml) =>
      yaml.replace("type: workflow", "type: workflow\nmode: write_sometimes")
    );
    await expect(loadWorkflowDefinition(modeRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({ code: "workflow_schema_invalid", path: "$.mode" });

    const executionRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(executionRoot, "minimum", (yaml) =>
      `${yaml}\nexecution:\n  max_concurrency: 0\n`
    );
    await expect(loadWorkflowDefinition(executionRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_schema_invalid",
      path: "$.execution.max_concurrency"
    });

    const requiresRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(requiresRoot, "minimum", (yaml) =>
      `${yaml}\nrequires:\n  repository: yes\n`
    );
    await expect(loadWorkflowDefinition(requiresRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_schema_invalid",
      path: "$.requires.repository"
    });

    const subagentRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(subagentRoot, "minimum", (yaml) =>
      `${yaml}\nsubagent_policy:\n  allow_tools: [git]\n`
    );
    await expect(loadWorkflowDefinition(subagentRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_unknown_field",
      path: "$.subagent_policy.allow_tools"
    });

    const observabilityRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(observabilityRoot, "minimum", (yaml) =>
      `${yaml}\nobservability:\n  exporters:\n    custom_runtime_log:\n      enabled: false\n`
    );
    await expect(loadWorkflowDefinition(observabilityRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_unknown_field",
      path: "$.observability.exporters.custom_runtime_log"
    });
  });

  it("rejects un-namespaced capability ids, string magic expressions, invalid expressions, and schema mismatches", async () => {
    const root = await copyWorkflowFixture("minimum");
    await patchWorkflow(root, "minimum", (yaml) =>
      yaml.replace("uses: context.collect_context", "uses: collect_context")
    );
    await expect(
      loadWorkflowDefinition(root, "minimum", {
        capabilityRegistry: registry(),
        digestResolver: digestResolver()
      })
    ).rejects.toMatchObject({ code: "workflow_capability_id_unqualified" });

    const magicRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(magicRoot, "minimum", (yaml) =>
      yaml.replace(
        "    uses: context.collect_context",
        "    uses: context.collect_context\n    input:\n      repository: $.invocation.repo"
      )
    );
    await expect(
      loadWorkflowDefinition(magicRoot, "minimum", {
        capabilityRegistry: registry(),
        digestResolver: digestResolver()
      })
    ).rejects.toMatchObject({ code: "workflow_string_expression", path: "$.nodes[0].input.repository" });

    const expressionRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(expressionRoot, "minimum", (yaml) =>
      yaml.replace('expression: "$.steps.context"', 'expression: "$.steps.missing"')
    );
    await expect(
      loadWorkflowDefinition(expressionRoot, "minimum", {
        capabilityRegistry: registry(),
        digestResolver: digestResolver()
      })
    ).rejects.toMatchObject({
      code: "workflow_expression_unresolved",
      path: "$.nodes[0].artifacts[0].source.expression",
      capability: "artifacts.manifest_publisher"
    });

    const mismatchRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(mismatchRoot, "minimum", (yaml) =>
      yaml.replace("sections:", "sections: nope\n      bad:")
    );
    await expect(
      loadWorkflowDefinition(mismatchRoot, "minimum", {
        capabilityRegistry: registry(),
        digestResolver: digestResolver()
      })
    ).rejects.toMatchObject({
      code: "workflow_capability_config_invalid",
      capability: "reports.final_report"
    });
  });

  it("validates pattern gates, local expression contexts, human gate decisions, and external agent digests", async () => {
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
capabilities: [quality-gates, agents]
nodes:
  - id: loop
    type: pattern
    uses: quality-gates.gated_agent_loop
    worker: writer
    gates:
      - id: review
        type: quality-gates.agent_review
        input:
          review_agent: reviewer
          subject:
            expression: "$.gate.output"
        decision:
          decision: fail
          feedback:
            message: revise
    repair:
      attempts: 2
`
    );

    const loaded = await loadWorkflowDefinition(root, "loop", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver({
        "agents/writer/agent.yaml": "sha256:writer",
        "agents/reviewer/agent.yaml": "sha256:reviewer"
      })
    });
    expect(loaded.external_definition_digests).toEqual({
      "agents/reviewer/agent.yaml": "sha256:reviewer",
      "agents/writer/agent.yaml": "sha256:writer"
    });

    await patchWorkflow(root, "loop", (yaml) =>
      yaml.replace("$.gate.output", "$.unknown.output")
    );
    await expect(
      loadWorkflowDefinition(root, "loop", {
        capabilityRegistry: registry(),
        digestResolver: digestResolver({
          "agents/writer/agent.yaml": "sha256:writer",
          "agents/reviewer/agent.yaml": "sha256:reviewer"
        })
      })
    ).rejects.toMatchObject({
      code: "workflow_expression_unresolved",
      path: "$.nodes[0].gates[0].input.subject.expression",
      capability: "quality-gates.agent_review"
    });

    await patchWorkflow(root, "loop", (yaml) =>
      yaml.replace("$.unknown.output", "$.gate.output").replace("decision: fail", "decision: maybe")
    );
    await expect(
      loadWorkflowDefinition(root, "loop", {
        capabilityRegistry: registry(),
        digestResolver: digestResolver({
          "agents/writer/agent.yaml": "sha256:writer",
          "agents/reviewer/agent.yaml": "sha256:reviewer"
        })
      })
    ).rejects.toMatchObject({
      code: "workflow_capability_config_invalid",
      capability: "quality-gates.agent_review"
    });
  });

  it("rejects unknown nested fields in nodes, gates, artifacts, policies, and pattern config", async () => {
    const nodeRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(nodeRoot, "minimum", (yaml) =>
      yaml.replace("uses: context.collect_context", "uses: context.collect_context\n    surprise: nope")
    );
    await expect(loadWorkflowDefinition(nodeRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({ code: "workflow_unknown_field", path: "$.nodes[0].surprise" });

    const gateRoot = await loopWorkflowRoot();
    await patchWorkflow(gateRoot, "loop", (yaml) =>
      yaml.replace("type: test-cap.strict_gate", "type: test-cap.strict_gate\n        surprise: nope")
    );
    await expect(loadWorkflowDefinition(gateRoot, "loop", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver({ "agents/writer/agent.yaml": "sha256:writer" })
    })).rejects.toMatchObject({ code: "workflow_unknown_field", path: "$.nodes[0].gates[0].surprise" });

    const artifactRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(artifactRoot, "minimum", (yaml) =>
      yaml.replace("format: json", "format: json\n        surprise: nope")
    );
    await expect(loadWorkflowDefinition(artifactRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({ code: "workflow_unknown_field", path: "$.nodes[0].artifacts[0].surprise" });

    const policyRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(policyRoot, "minimum", (yaml) =>
      yaml.replace("  - artifacts\n", "  - artifacts\n  - test-cap\n").replace(
        "    uses: context.collect_context",
        "    uses: context.collect_context\n    policies:\n      - uses: test-cap.strict_policy\n        surprise: nope"
      )
    );
    await expect(loadWorkflowDefinition(policyRoot, "minimum", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({ code: "workflow_unknown_field", path: "$.nodes[0].policies[0].surprise" });

    const patternRoot = await patternWorkflowRoot("test-cap.strict_pattern", "test-cap");
    await expect(loadWorkflowDefinition(patternRoot, "patterned", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_capability_config_invalid",
      capability: "test-cap.strict_pattern",
      path: "$.nodes[0]"
    });
  });

  it("rejects missing declared capabilities and un-namespaced ids for gates, policies, and artifact publishers", async () => {
    const gateRoot = await loopWorkflowRoot({ capabilities: "capabilities: [quality-gates, agents]" });
    await expect(loadWorkflowDefinition(gateRoot, "loop", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver({ "agents/writer/agent.yaml": "sha256:writer" })
    })).rejects.toMatchObject({ code: "workflow_capability_missing", capability: "test-cap" });

    const unnamespacedGateRoot = await loopWorkflowRoot({
      gateType: "strict_gate",
      capabilities: "capabilities: [quality-gates, agents, test-cap]"
    });
    await expect(loadWorkflowDefinition(unnamespacedGateRoot, "loop", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver({ "agents/writer/agent.yaml": "sha256:writer" })
    })).rejects.toMatchObject({ code: "workflow_capability_id_unqualified", path: "$.nodes[0].gates[0].type" });

    const policyRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(policyRoot, "minimum", (yaml) =>
      yaml.replace(
        "    uses: context.collect_context",
        "    uses: context.collect_context\n    policies:\n      - uses: strict_policy\n        config:\n          flag: true"
      )
    );
    await expect(loadWorkflowDefinition(policyRoot, "minimum", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({ code: "workflow_capability_id_unqualified", path: "$.nodes[0].policies[0].uses" });

    const publisherRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(publisherRoot, "minimum", (yaml) =>
      yaml.replace("publisher: artifacts.manifest_publisher", "publisher: strict_publisher")
    );
    await expect(loadWorkflowDefinition(publisherRoot, "minimum", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({ code: "workflow_capability_id_unqualified", path: "$.nodes[0].artifacts[0].publisher" });
  });

  it("rejects invalid graph references and artifact sources with precise paths", async () => {
    const afterRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(afterRoot, "minimum", (yaml) =>
      yaml.replace("after: [context]", "after: [missing]")
    );
    await expect(loadWorkflowDefinition(afterRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({ code: "workflow_reference_unknown", path: "$.nodes[1].after[0]" });

    const branchesRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(branchesRoot, "minimum", (yaml) => `${yaml}
branches:
  - from: context
    when:
      expression: "$.steps.context.enabled"
    to: final_report
`);
    await expect(loadWorkflowDefinition(branchesRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({ code: "workflow_unknown_field", path: "$.branches" });

    const artifactRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(artifactRoot, "minimum", (yaml) =>
      yaml.replace('expression: "$.steps.context"', 'expression: "$.steps.missing"')
    );
    await expect(loadWorkflowDefinition(artifactRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_expression_unresolved",
      path: "$.nodes[0].artifacts[0].source.expression"
    });
  });

  it("rejects string magic and includes YAML path and capability on expression errors", async () => {
    const stringRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(stringRoot, "minimum", (yaml) =>
      yaml.replace(
        "    uses: context.collect_context",
        "    uses: context.collect_context\n    input:\n      repository: $.steps.context"
      )
    );
    await expect(loadWorkflowDefinition(stringRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_string_expression",
      path: "$.nodes[0].input.repository"
    });

    const gateRoot = await loopWorkflowRoot();
    await patchWorkflow(gateRoot, "loop", (yaml) =>
      yaml.replace("$.gate.output", "$.missing.output")
    );
    await expect(loadWorkflowDefinition(gateRoot, "loop", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver({ "agents/writer/agent.yaml": "sha256:writer" })
    })).rejects.toMatchObject({
      code: "workflow_expression_unresolved",
      path: "$.nodes[0].gates[0].input.subject.expression",
      capability: "test-cap.strict_gate"
    });
  });

  it("rejects local context root shadowing and capability schema mismatches", async () => {
    const shadowRoot = await loopWorkflowRoot({ gateType: "test-cap.shadow_gate" });
    await expect(loadWorkflowDefinition(shadowRoot, "loop", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver({ "agents/writer/agent.yaml": "sha256:writer" })
    })).rejects.toMatchObject({
      code: "workflow_expression_context_shadow",
      capability: "test-cap.shadow_gate"
    });

    const builtInRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(builtInRoot, "minimum", (yaml) =>
      yaml.replace("  - context\n", "  - context\n  - test-cap\n").replace(
        "uses: context.collect_context",
        "uses: test-cap.strict_builtin\n    input:\n      flag: nope"
      )
    );
    await expect(loadWorkflowDefinition(builtInRoot, "minimum", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_capability_config_invalid",
      capability: "test-cap.strict_builtin"
    });

    const gateRoot = await loopWorkflowRoot();
    await patchWorkflow(gateRoot, "loop", (yaml) =>
      yaml.replace("flag: true", "flag: nope")
    );
    await expect(loadWorkflowDefinition(gateRoot, "loop", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver({ "agents/writer/agent.yaml": "sha256:writer" })
    })).rejects.toMatchObject({
      code: "workflow_capability_config_invalid",
      capability: "test-cap.strict_gate"
    });

    const policyRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(policyRoot, "minimum", (yaml) =>
      yaml.replace("  - artifacts\n", "  - artifacts\n  - test-cap\n").replace(
        "    uses: context.collect_context",
        "    uses: context.collect_context\n    policies:\n      - uses: test-cap.strict_policy\n        config:\n          flag: nope"
      )
    );
    await expect(loadWorkflowDefinition(policyRoot, "minimum", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_capability_config_invalid",
      capability: "test-cap.strict_policy"
    });

    const humanRoot = await humanGateWorkflowRoot("maybe");
    await expect(loadWorkflowDefinition(humanRoot, "human", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_capability_config_invalid",
      capability: "test-cap.strict_gate",
      path: "$.nodes[0].decision"
    });
  });

  it("rejects missing agent output schemas", async () => {
    const root = await copyWorkflowFixture("minimum");
    await patchWorkflow(root, "minimum", (yaml) =>
      yaml.replace("  - artifacts\n", "  - artifacts\n  - agents\n").replace(
        "type: built_in\n    uses: context.collect_context",
        "type: agent\n    agent: reviewer"
      )
    );
    await expect(loadWorkflowDefinition(root, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver({ "agents/reviewer/agent.yaml": "sha256:reviewer" })
    })).rejects.toMatchObject({
      code: "workflow_agent_output_schema_missing",
      path: "$.nodes[0].output_schema"
    });
  });

  it("rejects legacy gated loop authoring and pattern nodes without explicit uses", async () => {
    const legacyRoot = await loopWorkflowRoot();
    await patchWorkflow(legacyRoot, "loop", (yaml) =>
      yaml.replace("type: pattern", "type: gated_agent_loop")
    );
    await expect(loadWorkflowDefinition(legacyRoot, "loop", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver({ "agents/writer/agent.yaml": "sha256:writer" })
    })).rejects.toMatchObject({
      code: "workflow_schema_invalid",
      path: "$.nodes[0].type"
    });

    const missingUsesRoot = await loopWorkflowRoot();
    await patchWorkflow(missingUsesRoot, "loop", (yaml) =>
      yaml.replace("    uses: quality-gates.gated_agent_loop\n", "")
    );
    await expect(loadWorkflowDefinition(missingUsesRoot, "loop", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver({ "agents/writer/agent.yaml": "sha256:writer" })
    })).rejects.toMatchObject({
      code: "workflow_schema_invalid",
      path: "$.nodes[0].uses"
    });
  });

  it("rejects accepted-but-unimplemented agent tools and missing agent output schema files or refs", async () => {
    const toolsRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(toolsRoot, "minimum", (yaml) =>
      yaml.replace("  - artifacts\n", "  - artifacts\n  - agents\n").replace(
        "type: built_in\n    uses: context.collect_context",
        "type: agent\n    agent: reviewer\n    output_schema: output.schema.json\n    tools:\n      - uses: local.echo"
      )
    );
    await expect(loadWorkflowDefinition(toolsRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver({ "agents/reviewer/agent.yaml": "sha256:reviewer" })
    })).rejects.toMatchObject({
      code: "workflow_unknown_field",
      path: "$.nodes[0].tools"
    });

    const missingFileRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(missingFileRoot, "minimum", (yaml) =>
      yaml.replace("  - artifacts\n", "  - artifacts\n  - agents\n").replace(
        "type: built_in\n    uses: context.collect_context",
        "type: agent\n    agent: reviewer\n    output_schema: missing.schema.json"
      )
    );
    await expect(loadWorkflowDefinition(missingFileRoot, "minimum", {
      capabilityRegistry: registry(),
      digestResolver: digestResolver({ "agents/reviewer/agent.yaml": "sha256:reviewer" })
    })).rejects.toMatchObject({
      code: "workflow_schema_missing",
      path: "$.nodes[0].output_schema"
    });

    const missingRefRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(missingRefRoot, "minimum", (yaml) =>
      yaml.replace("  - artifacts\n", "  - artifacts\n  - agents\n  - test-cap\n").replace(
        "type: built_in\n    uses: context.collect_context",
        "type: agent\n    agent: reviewer\n    output_schema: test-cap.missing_schema"
      )
    );
    await expect(loadWorkflowDefinition(missingRefRoot, "minimum", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver({ "agents/reviewer/agent.yaml": "sha256:reviewer" })
    })).rejects.toMatchObject({
      code: "workflow_capability_unknown",
      path: "$.nodes[0].output_schema"
    });
  });

  it("rejects legacy un-namespaced gate types and validates gate expressions", async () => {
    const agentGateRoot = await loopWorkflowRoot({
      gateType: "agent",
      capabilities: "capabilities: [quality-gates, agents, test-cap]"
    });
    await expect(loadWorkflowDefinition(agentGateRoot, "loop", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver({ "agents/writer/agent.yaml": "sha256:writer" })
    })).rejects.toMatchObject({
      code: "workflow_capability_id_unqualified",
      path: "$.nodes[0].gates[0].type"
    });

    const feedbackRoot = await loopWorkflowRoot();
    await patchWorkflow(feedbackRoot, "loop", (yaml) =>
      yaml.replace(
        "subject:\n            expression: \"$.gate.output\"",
        "subject:\n            expression: \"$.gate.output\"\n        feedback:\n          expression: \"$.steps.missing\""
      )
    );
    await expect(loadWorkflowDefinition(feedbackRoot, "loop", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver({ "agents/writer/agent.yaml": "sha256:writer" })
    })).rejects.toMatchObject({
      code: "workflow_expression_unresolved",
      capability: "test-cap.strict_gate",
      path: "$.nodes[0].gates[0].feedback.expression"
    });
  });

  it("validates artifact publisher registration, config, and declaring-node source ownership", async () => {
    const missingPublisherRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(missingPublisherRoot, "minimum", (yaml) =>
      yaml.replace("        publisher: artifacts.manifest_publisher\n", "")
    );
    await expect(loadWorkflowDefinition(missingPublisherRoot, "minimum", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_schema_invalid",
      path: "$.nodes[0].artifacts[0].publisher"
    });

    const unknownPublisherRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(unknownPublisherRoot, "minimum", (yaml) =>
      yaml.replace("  - artifacts\n", "  - artifacts\n  - test-cap\n")
        .replace("publisher: artifacts.manifest_publisher", "publisher: test-cap.missing_publisher")
    );
    await expect(loadWorkflowDefinition(unknownPublisherRoot, "minimum", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_capability_unknown",
      capability: "test-cap.missing_publisher",
      path: "$.nodes[0].artifacts[0].publisher"
    });

    const badConfigRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(badConfigRoot, "minimum", (yaml) =>
      yaml.replace("  - artifacts\n", "  - artifacts\n  - test-cap\n")
        .replace("publisher: artifacts.manifest_publisher", "publisher: test-cap.strict_publisher\n        config:\n          flag: nope")
    );
    await expect(loadWorkflowDefinition(badConfigRoot, "minimum", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_capability_config_invalid",
      capability: "test-cap.strict_publisher",
      path: "$.nodes[0].artifacts[0].config"
    });

    const wrongOwnerRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(wrongOwnerRoot, "minimum", (yaml) =>
      yaml.replace("  - artifacts\n", "  - artifacts\n  - test-cap\n")
        .replace("publisher: artifacts.manifest_publisher", "publisher: test-cap.strict_publisher\n        config:\n          flag: true")
        .replace('expression: "$.steps.context"', 'expression: "$.steps.final_report"')
    );
    await expect(loadWorkflowDefinition(wrongOwnerRoot, "minimum", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_reference_unknown",
      path: "$.nodes[0].artifacts[0].source.expression"
    });
  });

  it("validates numeric schema bounds and allows expression-valued fields under strict schemas", async () => {
    const boundedRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(boundedRoot, "minimum", (yaml) =>
      yaml.replace("  - context\n", "  - context\n  - test-cap\n").replace(
        "uses: context.collect_context",
        "uses: test-cap.bounded_builtin\n    input:\n      count: 1"
      )
    );
    await expect(loadWorkflowDefinition(boundedRoot, "minimum", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).rejects.toMatchObject({
      code: "workflow_capability_config_invalid",
      capability: "test-cap.bounded_builtin"
    });

    const expressionRoot = await copyWorkflowFixture("minimum");
    await patchWorkflow(expressionRoot, "minimum", (yaml) =>
      yaml.replace("  - context\n", "  - context\n  - test-cap\n").replace(
        "uses: context.collect_context",
        "uses: test-cap.bounded_builtin\n    input:\n      count:\n        expression: \"$.invocation.count\""
      )
    );
    await expect(loadWorkflowDefinition(expressionRoot, "minimum", {
      capabilityRegistry: registryWithTestCapability(),
      digestResolver: digestResolver()
    })).resolves.toMatchObject({ id: "minimum" });
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

async function humanGateWorkflowRoot(decision: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-workflows-"));
  const dir = path.join(root, "human");
  await mkdir(dir);
  await writeFile(path.join(dir, "input.schema.json"), "{\"type\":\"object\"}\n");
  await writeFile(path.join(dir, "output.schema.json"), "{\"type\":\"object\"}\n");
  await writeFile(
    path.join(dir, "workflow.yaml"),
    `id: human
type: workflow
input_schema: input.schema.json
output_schema: output.schema.json
capabilities: [test-cap]
nodes:
  - id: approval
    type: human_gate
    uses: test-cap.strict_gate
    decision:
      decision: ${decision}
`
  );
  return root;
}
