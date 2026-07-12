import { describe, expect, it } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { createStudioCapabilityCatalog } from "../../../src/studio/application/catalog/capability-catalog.js";
import { withStudioCapabilityConsumers } from "../../../src/studio/application/catalog/capability-consumers.js";
import type { StudioAgentCatalog } from "../../../src/studio/contracts/catalog.js";
import type { StudioWorkflowCatalog } from "../../../src/studio/contracts/workflow-catalog.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "sample",
    kind: "execution",
    version: "1.0.0",
    built_ins: {
      "sample.run": {
        id: "sample.run",
        input_schema: { type: "object" },
        output_schema: { type: "object" }
      }
    },
    tools: {
      "sample.inspect": {
        id: "sample.inspect",
        protocol: "local",
        input_schema: { type: "object" },
        output_schema: { type: "object" }
      }
    },
    schemas: {
      "sample.output": {
        id: "sample.output",
        schema: { type: "object" }
      }
    }
  })
]);

function workflows(status: "complete" | "partial" = "complete"): StudioWorkflowCatalog {
  return {
    status,
    fingerprint: digest("1"),
    workflows: [{
      id: "review",
      mode: "read_only",
      revision: digest("2"),
      capabilities: ["sample"],
      registrations: ["sample.run"],
      agents: [],
      input_schema: "input.schema.json",
      output_schema: "output.schema.json",
      input_schema_content: { type: "object" },
      output_schema_content: { type: "object" },
      synchronous_composition: "allowed",
      node_counts: {
        built_in: 1,
        agent: 0,
        pattern: 0,
        human_gate: 0,
        workflow: 0
      },
      requires_repository: false,
      max_concurrency: 1
    }],
    diagnostics: []
  };
}

function agents(status: "complete" | "partial" = "complete"): StudioAgentCatalog {
  return {
    status,
    fingerprint: digest("3"),
    agents: [{
      id: "reviewer",
      description: "Reviews",
      mode: "read_only",
      model_profile: "default",
      output_schema_reference: "sample.output",
      output_schema: { type: "object" },
      skills: [],
      tools: ["sample.inspect"],
      mcp_servers: [],
      subagents: [],
      runtime_requirements: [],
      runtime_order: [],
      revision: digest("4")
    }],
    diagnostics: []
  };
}

describe("Studio capability consumer index", () => {
  it("indexes workflow and agent consumers from validated catalogs", () => {
    const catalog = withStudioCapabilityConsumers({
      catalog: createStudioCapabilityCatalog(registry),
      workflows: workflows(),
      agents: agents()
    });

    expect(catalog.consumers).toMatchObject({
      status: "complete",
      incomplete_sources: [],
      capabilities: {
        sample: { workflows: ["review"], agents: ["reviewer"] }
      },
      registrations: {
        "sample.run": { workflows: ["review"], agents: [] },
        "sample.inspect": { workflows: [], agents: ["reviewer"] },
        "sample.output": { workflows: [], agents: ["reviewer"] }
      }
    });
  });

  it("marks the reverse index partial instead of claiming absent consumers", () => {
    const catalog = withStudioCapabilityConsumers({
      catalog: createStudioCapabilityCatalog(registry),
      workflows: workflows("partial"),
      agents: agents("partial")
    });

    expect(catalog.consumers).toMatchObject({
      status: "partial",
      incomplete_sources: ["workflows", "agents"]
    });
  });
});
