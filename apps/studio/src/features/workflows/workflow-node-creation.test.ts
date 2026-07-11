import { describe, expect, it } from "vitest"

import type { AgentCatalogItem, CapabilityCatalog, JsonValue } from "@/api/types"
import {
  createWorkflowNodeOperations,
  suggestWorkflowNodeId,
} from "@/features/workflows/workflow-node-creation"
import { workflowSourceNodes } from "@/features/workflows/workflow-source-model"

const library: CapabilityCatalog = {
  technical_fingerprint: `sha256:${"1".repeat(64)}`,
  presentation_fingerprint: `sha256:${"2".repeat(64)}`,
  capabilities: [{
    id: "agents",
    version: "1",
    kind: "execution",
    workflow_node_types: ["agent"],
    depends_on: [],
    presets: {},
    re_exports: {
      built_ins: [], patterns: [], tools: [], gates: [], policies: [], ports: [], artifact_publishers: [],
    },
    presentation: { title: "Agents" },
    docs: [],
  }],
  registrations: [],
}

const reviewer: AgentCatalogItem = {
  id: "change-reviewer",
  description: "Review changes",
  mode: "read_only",
  model_profile: "default",
  output_schema_reference: "output.schema.json",
  output_schema: { type: "object" },
  skills: [],
  tools: [],
  mcp_servers: [],
  subagents: [],
  runtime_requirements: [],
  runtime_order: [],
  revision: `sha256:${"3".repeat(64)}`,
}

describe("workflow node creation", () => {
  it("generates stable unique ids without asking the user for an implementation detail", () => {
    const nodes = workflowSourceNodes({
      nodes: [
        { id: "collect_context", type: "built_in", uses: "context.collect_context" },
        { id: "collect_context_2", type: "built_in", uses: "context.collect_context" },
      ],
    })
    expect(suggestWorkflowNodeId("context.collect_context", nodes)).toBe("collect_context_3")
  })

  it("adds an agent and its visual dependency in one canonical batch", () => {
    const source: JsonValue = {
      capabilities: [],
      nodes: [{ id: "context", type: "built_in", uses: "context.collect_context" }],
    }
    const nodes = workflowSourceNodes(source)
    expect(createWorkflowNodeOperations({
      source,
      nodes,
      library,
      agents: [reviewer],
      kind: "agent",
      registrationId: reviewer.id,
      afterNodeId: "context",
    })).toEqual({
      id: "change-reviewer",
      operations: [
        { op: "sequence_insert", path: ["capabilities"], value: "agents" },
        {
          op: "sequence_insert",
          path: ["nodes"],
          value: {
            id: "change-reviewer",
            type: "agent",
            agent: "change-reviewer",
            output_schema: "output.schema.json",
            after: ["context"],
          },
        },
      ],
    })
  })

  it("inserts a step into an existing edge without leaving a parallel dependency", () => {
    const source: JsonValue = {
      capabilities: [],
      nodes: [
        { id: "context", type: "agent", agent: reviewer.id },
        { id: "report", type: "agent", agent: reviewer.id, after: ["context"] },
      ],
    }
    const result = createWorkflowNodeOperations({
      source,
      nodes: workflowSourceNodes(source),
      library,
      agents: [reviewer],
      kind: "agent",
      registrationId: reviewer.id,
      afterNodeId: "context",
      beforeNodeId: "report",
    })

    expect(result?.operations.at(-1)).toEqual({
      op: "set",
      path: ["nodes", 1, "after"],
      value: ["change-reviewer"],
    })
  })
})
