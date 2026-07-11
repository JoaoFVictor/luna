import { describe, expect, it } from "vitest"
import type { AgentCatalogItem, CapabilityCatalog, JsonValue } from "@/api/types"

import {
  addWorkflowCapabilityOperations,
  workflowDependencyWouldCycle,
  workflowSourceOutlineEntries,
  workflowSourceNodes,
} from "@/features/workflows/workflow-source-model"
import { workflowSideEffectPreview } from "@/features/workflows/workflow-side-effect-preview"

const emptyLibrary: CapabilityCatalog = {
  technical_fingerprint: `sha256:${"1".repeat(64)}`,
  presentation_fingerprint: `sha256:${"2".repeat(64)}`,
  capabilities: [],
  registrations: [],
}

function catalogAgent(
  id: string,
  options: {
    mode?: AgentCatalogItem["mode"]
    tools?: readonly string[]
    subagents?: AgentCatalogItem["subagents"]
  } = {},
): AgentCatalogItem {
  return {
    id,
    description: id,
    mode: options.mode ?? "read_only",
    model_profile: "default",
    output_schema_reference: "output.schema.json",
    output_schema: { type: "object" },
    skills: [],
    tools: [...(options.tools ?? [])],
    mcp_servers: [],
    subagents: options.subagents ?? [],
    runtime_requirements: [],
    runtime_order: [],
    revision: `sha256:${"3".repeat(64)}`,
  }
}

const source: JsonValue = {
  nodes: [
    { id: "first", type: "built_in", uses: "runtime.preflight" },
    { id: "second", type: "agent", agent: "reviewer", output_schema: "output.schema.json", after: ["first"] },
    { id: "third", type: "pattern", uses: "quality-gates.gated_agent_loop", after: ["first", "second"] },
  ],
}

describe("workflow source model", () => {
  it("deduplicates capabilities across the source and one atomic batch", () => {
    expect(addWorkflowCapabilityOperations(
      { capabilities: ["runtime"] },
      ["runtime", "publishing", "publishing", undefined, "agents"],
    )).toEqual([
      { op: "sequence_insert", path: ["capabilities"], value: "publishing" },
      { op: "sequence_insert", path: ["capabilities"], value: "agents" },
    ])
  })

  it("detects a cycle before adding an after dependency", () => {
    const nodes = workflowSourceNodes(source)
    expect(workflowDependencyWouldCycle(nodes, "first", "third")).toBe(true)
    expect(workflowDependencyWouldCycle(nodes, "second", "third")).toBe(true)
    expect(workflowDependencyWouldCycle(nodes, "third", "first")).toBe(false)
  })

  it("keeps every malformed or duplicate source item addressable by index", () => {
    const entries = workflowSourceOutlineEntries({
      nodes: [
        { id: "same", type: "built_in", uses: "runtime.first" },
        { id: "same", type: "agent", agent: "reviewer" },
        { type: "unknown", uses: "missing.kind" },
        "not-a-mapping",
      ],
    })

    expect(entries).toHaveLength(4)
    expect(entries.map((entry) => entry.selectionId)).toEqual([
      "source-node:0",
      "source-node:1",
      "source-node:2",
      "source-node:3",
    ])
    expect(entries[0]?.problems).toContain("O id same está duplicado.")
    expect(entries[2]).toMatchObject({
      label: "Node 3 (id ausente)",
      typeLabel: "unknown (inválido)",
      registrationLabel: "missing.kind",
    })
    expect(entries[3]?.problems).toContain("O node deve ser um mapping YAML.")
  })

  it("projects worker and gate review agents fail-closed for pattern side effects", () => {
    const effects = workflowSideEffectPreview(
      {
        nodes: [{
          id: "repair",
          type: "pattern",
          uses: "quality-gates.gated_agent_loop",
          worker: "writer",
          gates: [{
            id: "review",
            type: "quality-gates.agent_review",
            input: { review_agent: "reviewer" },
          }],
        }],
      },
      emptyLibrary,
      [
        catalogAgent("writer", { mode: "trusted_local_write" }),
        catalogAgent("reviewer", { subagents: [{ id: "security" }] }),
      ],
      true,
    )

    expect(effects.map((effect) => effect.description)).toEqual(expect.arrayContaining([
      expect.stringContaining("Agent writer"),
      expect.stringContaining("Agent reviewer"),
    ]))
    expect(effects).not.toContainEqual(expect.objectContaining({ nodeId: "workflow" }))
  })

  it("never reports no effects when an agent reference or catalog is unresolved", () => {
    const effects = workflowSideEffectPreview(
      { nodes: [{ id: "review", type: "agent", agent: "missing" }] },
      emptyLibrary,
      [],
      false,
    )

    expect(effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "workflow", semantics: "unknown" }),
      expect.objectContaining({ nodeId: "review", semantics: "unknown" }),
    ]))
  })
})
