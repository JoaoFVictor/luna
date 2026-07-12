import { describe, expect, it } from "vitest"

import type { CapabilityRegistration, CapabilitySummary, WorkflowSummary } from "@/api/types"
import {
  workflowRecommendedPaletteItems,
  reconcileWorkflowBuiltInPolicies,
  workflowAgentCapabilityIds,
  workflowNodeCapabilityIds,
  workflowNodePaletteItems,
} from "@/features/workflows/workflow-node-catalog"

const noReExports = {
  built_ins: [],
  patterns: [],
  tools: [],
  gates: [],
  policies: [],
  ports: [],
  artifact_publishers: [],
}

function capability(
  id: string,
  workflowNodeTypes: readonly "agent"[] = [],
): CapabilitySummary {
  return {
    id,
    version: "1.0.0",
    kind: "execution",
    workflow_node_types: [...workflowNodeTypes],
    depends_on: [],
    presets: {},
    re_exports: noReExports,
    presentation: { title: id },
    docs: [],
  }
}

const outputSchema: CapabilityRegistration = {
  registration_kind: "schema",
  id: "structured-output.review",
  owner: {
    capability_id: "structured-output",
    capability_version: "1.0.0",
    capability_kind: "execution",
  },
  presentation: { title: "Review output" },
  schema: { type: "object" },
}

const owner = {
  capability_id: "effects",
  capability_version: "1.0.0",
  capability_kind: "execution" as const,
}

function builtIn(
  id: string,
  sideEffectPolicy?: string,
): CapabilityRegistration {
  return {
    registration_kind: "built_in",
    id,
    owner,
    presentation: { title: id },
    input_schema: {},
    output_schema: {},
    required_ports: [],
    requires_repository: false,
    ...(sideEffectPolicy === undefined
      ? {}
      : { side_effect_policy: sideEffectPolicy }),
  }
}

function policy(id: string, operationId: string): CapabilityRegistration {
  return {
    registration_kind: "policy",
    id,
    owner,
    presentation: { title: id },
    config_schema: {},
    local_context_roots: [],
    side_effect_semantics: "write",
    side_effect_operation_ids: [operationId],
    error_codes: [],
  }
}

describe("workflow node capability projection", () => {
  it("adds installed child workflows to the palette and excludes the workflow being edited", () => {
    const workflow = (id: string): WorkflowSummary => ({
      id,
      mode: "read_only",
      revision: `sha256:${"7".repeat(64)}`,
      capabilities: [],
      registrations: [],
      agents: [],
      input_schema: "input.schema.json",
      output_schema: "output.schema.json",
      input_schema_content: { type: "object" },
      output_schema_content: { type: "object" },
      synchronous_composition: "allowed",
      node_counts: { built_in: 0, agent: 0, pattern: 0, human_gate: 0, workflow: 0 },
      requires_repository: false,
      max_concurrency: 1,
    })

    expect(workflowNodePaletteItems([], [], [workflow("parent"), workflow("child")], new Set(["parent"])))
      .toEqual([expect.objectContaining({
        id: "child",
        kind: "workflow",
        category: "Subworkflows",
      })])
  })

  it("ranks common safe building blocks ahead of alphabetical advanced actions", () => {
    const item = (id: string, kind: "built_in" | "agent", hasExternalEffect = false) => ({
      id,
      kind,
      title: id,
      summary: id,
      category: kind === "agent" ? "Agents" : "Ações",
      tags: [],
      hasExternalEffect,
      requiresRepository: false,
    })
    const ranked = workflowRecommendedPaletteItems([
      item("change-request.create", "built_in", true),
      item("reviewer", "agent"),
      item("runtime.preflight", "built_in"),
      item("context.collect_context", "built_in"),
    ])

    expect(ranked.map((entry) => entry.id)).toEqual([
      "context.collect_context",
      "runtime.preflight",
      "reviewer",
      "change-request.create",
    ])
  })

  it("uses a semantic node role without assuming a public capability id", () => {
    const capabilities = [
      capability("unrelated"),
      capability("model-execution", ["agent"]),
    ]

    expect(workflowNodeCapabilityIds(capabilities, "agent")).toEqual([
      "model-execution",
    ])
    expect(workflowNodeCapabilityIds(capabilities, "pattern")).toEqual([])
  })

  it("combines the projected agent owner with the selected schema owner", () => {
    expect(workflowAgentCapabilityIds(
      [capability("model-execution", ["agent"]), capability("structured-output")],
      [outputSchema],
      outputSchema.id,
    )).toEqual(["model-execution", "structured-output"])
  })
})

describe("built-in policy reconciliation", () => {
  const writeA = builtIn("effects.write-a", "effects.write-a-policy")
  const writeB = builtIn("effects.write-b", "effects.write-b-policy")
  const read = builtIn("effects.read")
  const writeAPolicy = policy("effects.write-a-policy", "effects.write-a")
  const writeBPolicy = policy("effects.write-b-policy", "effects.write-b")
  const registrations = [writeA, writeB, read, writeAPolicy, writeBPolicy]
  const explicitPolicy = { uses: "audit.explicit", config: { level: "strict" } }

  it("removes the former implicit policy on write to read and preserves explicit policies", () => {
    expect(reconcileWorkflowBuiltInPolicies(
      registrations,
      writeA,
      read,
      [explicitPolicy, { uses: writeAPolicy.id, config: { operation_id: "effects.write-a" } }],
    )).toEqual([explicitPolicy])
  })

  it("replaces only the former implicit policy on write A to write B", () => {
    expect(reconcileWorkflowBuiltInPolicies(
      registrations,
      writeA,
      writeB,
      [
        explicitPolicy,
        { uses: writeAPolicy.id, config: { operation_id: "effects.write-a" } },
        { uses: "notify.explicit", config: {} },
      ],
    )).toEqual([
      explicitPolicy,
      { uses: writeBPolicy.id, config: { operation_id: "effects.write-b" } },
      { uses: "notify.explicit", config: {} },
    ])
  })
})
