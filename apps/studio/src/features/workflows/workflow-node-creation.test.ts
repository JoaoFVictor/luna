import { describe, expect, it } from "vitest"

import type { AgentCatalogItem, CapabilityCatalog, JsonValue, WorkflowSummary } from "@/api/types"
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

const childWorkflow: WorkflowSummary = {
  id: "review-child",
  mode: "read_only",
  revision: `sha256:${"4".repeat(64)}`,
  capabilities: ["reports"],
  registrations: ["reports.final_report"],
  agents: [],
  input_schema: "input.schema.json",
  output_schema: "output.schema.json",
  input_schema_content: {
    type: "object",
    required: ["version", "source", "issue"],
    properties: {
      version: { type: "string", const: "v1" },
      source: { $ref: "#/$defs/source" },
      issue: { type: "string" },
    },
    $defs: { source: { type: "object", required: ["provider"] } },
  },
  output_schema_content: { type: "object", properties: { report: { type: "string" } } },
  synchronous_composition: "allowed",
  node_counts: { built_in: 1, agent: 0, pattern: 0, human_gate: 0, workflow: 0 },
  requires_repository: true,
  max_concurrency: 1,
}

describe("workflow node creation", () => {
  it("creates a canonical child workflow call without a fake capability or uses field", () => {
    const result = createWorkflowNodeOperations({
      source: { id: "parent", mode: "read_only", capabilities: [], nodes: [] },
      nodes: [],
      library,
      agents: [],
      workflows: [childWorkflow],
      kind: "workflow",
      registrationId: childWorkflow.id,
    })

    expect(result).toEqual({
      id: "review-child",
      operations: [
        { op: "set", path: ["requires"], value: { repository: true } },
        {
          op: "sequence_insert",
          path: ["nodes"],
          value: {
            id: "review-child",
            type: "workflow",
            workflow: "review-child",
            input: { version: "v1" },
          },
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('"uses"')
    expect(JSON.stringify(result)).not.toContain('"capabilities","value"')
  })

  it("refuses child workflows the backend cannot compose safely", () => {
    expect(createWorkflowNodeOperations({
      source: { id: "parent", mode: "read_only", capabilities: [], nodes: [] },
      nodes: [],
      library,
      agents: [],
      workflows: [{ ...childWorkflow, mode: "trusted_local_write" }],
      kind: "workflow",
      registrationId: childWorkflow.id,
    })).toBeUndefined()

    expect(createWorkflowNodeOperations({
      source: { id: "parent", mode: "trusted_local_write", capabilities: [], nodes: [] },
      nodes: [],
      library,
      agents: [],
      workflows: [{
        ...childWorkflow,
        synchronous_composition: "blocked",
        synchronous_composition_blocked_reason: "human_input",
        node_counts: { ...childWorkflow.node_counts, human_gate: 1 },
      }],
      kind: "workflow",
      registrationId: childWorkflow.id,
    })).toBeUndefined()
  })

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

  it("does not invent values for required schema fields without explicit defaults", () => {
    const finalReport = {
      registration_kind: "built_in" as const,
      id: "reports.final_report",
      owner: { capability_id: "reports", capability_version: "1", capability_kind: "execution" as const },
      presentation: { title: "Gerar relatório final" },
      input_schema: {
        type: "object",
        required: ["sections"],
        properties: { sections: { type: "array" } },
      },
      output_schema: { type: "object" },
      required_ports: [],
      requires_repository: false,
    }
    const reportLibrary: CapabilityCatalog = {
      ...library,
      capabilities: [{ ...library.capabilities[0], id: "reports" }],
      registrations: [finalReport],
    }
    const result = createWorkflowNodeOperations({
      source: { capabilities: [], nodes: [] },
      nodes: [],
      library: reportLibrary,
      agents: [],
      kind: "built_in",
      registrationId: finalReport.id,
    })

    expect(result?.operations.at(-1)).toEqual({
      op: "sequence_insert",
      path: ["nodes"],
      value: {
        id: "final_report",
        type: "built_in",
        uses: "reports.final_report",
      },
    })
  })

  it("adds repository authority atomically for a repository-backed block", () => {
    const preflight = {
      registration_kind: "built_in" as const,
      id: "runtime.preflight",
      owner: { capability_id: "runtime", capability_version: "1", capability_kind: "execution" as const },
      presentation: { title: "Verificar ambiente" },
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      required_ports: [],
      requires_repository: true,
    }
    const result = createWorkflowNodeOperations({
      source: { capabilities: [], nodes: [] },
      nodes: [],
      library: {
        ...library,
        capabilities: [{ ...library.capabilities[0], id: "runtime" }],
        registrations: [preflight],
      },
      agents: [],
      kind: "built_in",
      registrationId: preflight.id,
    })

    expect(result?.operations).toContainEqual({
      op: "set",
      path: ["requires"],
      value: { repository: true },
    })
  })

  it("refuses to create normal work after a deferred final result", () => {
    const finalReport = {
      registration_kind: "built_in" as const,
      id: "reports.final_report",
      owner: { capability_id: "reports", capability_version: "1", capability_kind: "execution" as const },
      presentation: { title: "Gerar relatório final" },
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      required_ports: [],
      requires_repository: false,
      deferred_lifecycle: "final_report" as const,
    }
    const source: JsonValue = {
      nodes: [{ id: "report", type: "built_in", uses: finalReport.id }],
    }

    expect(createWorkflowNodeOperations({
      source,
      nodes: workflowSourceNodes(source),
      library: { ...library, registrations: [finalReport] },
      agents: [reviewer],
      kind: "agent",
      registrationId: reviewer.id,
      afterNodeId: "report",
    })).toBeUndefined()
  })
})
