import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type {
  AgentCatalogItem,
  CapabilityCatalog,
  CapabilityRegistration,
  CapabilitySummary,
  JsonValue,
} from "@/api/types"
import { WorkflowNodeInspector } from "@/features/workflows/workflow-node-inspector"
import { workflowSourceNodes } from "@/features/workflows/workflow-source-model"

const DIGEST = `sha256:${"1".repeat(64)}`
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
    re_exports: {
      built_ins: [],
      patterns: [],
      tools: [],
      gates: [],
      policies: [],
      ports: [],
      artifact_publishers: [],
    },
    presentation: { title: id },
    docs: [],
  }
}

function library(
  registrations: readonly CapabilityRegistration[],
  capabilities: readonly CapabilitySummary[] = [capability("effects")],
): CapabilityCatalog {
  return {
    technical_fingerprint: DIGEST,
    presentation_fingerprint: DIGEST,
    capabilities: [...capabilities],
    registrations: [...registrations],
  }
}

function renderInspector(
  source: JsonValue,
  catalog: CapabilityCatalog,
  agents: readonly AgentCatalogItem[] = [],
) {
  const nodes = workflowSourceNodes(source)
  const selected = nodes[0]
  if (selected === undefined) throw new Error("Test source must contain one valid node")
  const onOperations = vi.fn()
  render(
    <WorkflowNodeInspector
      source={source}
      nodes={nodes}
      selected={selected}
      library={catalog}
      agents={agents}
      canMutate
      pending={false}
      onOperations={onOperations}
      expressionFixtures={{}}
      onSaveExpressionFixture={vi.fn()}
      onRemoveExpressionFixture={vi.fn()}
      note=""
      onSaveNote={vi.fn()}
    />,
  )
  return onOperations
}

const writeA = builtIn("effects.write-a", "effects.write-a-policy")
const writeB = builtIn("effects.write-b", "effects.write-b-policy")
const read = builtIn("effects.read")
const writeAPolicy = policy("effects.write-a-policy", "effects.write-a")
const writeBPolicy = policy("effects.write-b-policy", "effects.write-b")
const effectRegistrations = [writeA, writeB, read, writeAPolicy, writeBPolicy]
const explicitPolicy = { uses: "audit.explicit", config: { level: "strict" } }

describe("WorkflowNodeInspector registration changes", () => {
  it("removes only the former implicit policy when changing write to read", () => {
    const source: JsonValue = {
      capabilities: ["effects"],
      nodes: [{
        id: "publish",
        type: "built_in",
        uses: writeA.id,
        policies: [
          explicitPolicy,
          { uses: writeAPolicy.id, config: { operation_id: "effects.write-a" } },
        ],
      }],
    }
    const onOperations = renderInspector(source, library(effectRegistrations))

    fireEvent.change(screen.getByLabelText("Registration / capability"), {
      target: { value: read.id },
    })

    expect(onOperations).toHaveBeenCalledWith([
      { op: "set", path: ["nodes", 0, "uses"], value: read.id },
      {
        op: "set",
        path: ["nodes", 0, "policies"],
        value: [explicitPolicy],
      },
    ])
  })

  it("replaces only the former implicit policy when changing write A to write B", () => {
    const trailingPolicy = { uses: "notify.explicit", config: {} }
    const source: JsonValue = {
      capabilities: ["effects"],
      nodes: [{
        id: "publish",
        type: "built_in",
        uses: writeA.id,
        policies: [
          explicitPolicy,
          { uses: writeAPolicy.id, config: { operation_id: "effects.write-a" } },
          trailingPolicy,
        ],
      }],
    }
    const onOperations = renderInspector(source, library(effectRegistrations))

    fireEvent.change(screen.getByLabelText("Registration / capability"), {
      target: { value: writeB.id },
    })

    expect(onOperations).toHaveBeenCalledWith([
      { op: "set", path: ["nodes", 0, "uses"], value: writeB.id },
      {
        op: "set",
        path: ["nodes", 0, "policies"],
        value: [
          explicitPolicy,
          { uses: writeBPolicy.id, config: { operation_id: "effects.write-b" } },
          trailingPolicy,
        ],
      },
    ])
  })
})

describe("WorkflowNodeInspector pattern worker", () => {
  const pattern: CapabilityRegistration = {
    registration_kind: "pattern",
    id: "quality.repair-loop",
    owner: {
      capability_id: "quality",
      capability_version: "1.0.0",
      capability_kind: "execution",
    },
    presentation: { title: "Repair loop" },
    declaring_node_type: "pattern",
    input_schema: {},
    output_schema: {},
    expand: { type: "declaring_node_subgraph" },
    batch_exclusion_keys: [],
    local_context_roots: [],
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
  const writer: AgentCatalogItem = {
    id: "writer",
    description: "Writer",
    mode: "trusted_local_write",
    model_profile: "default",
    output_schema_reference: outputSchema.id,
    output_schema: { type: "object" },
    skills: [],
    tools: [],
    mcp_servers: [],
    subagents: [],
    runtime_requirements: [],
    runtime_order: [],
    revision: `sha256:${"2".repeat(64)}`,
  }

  it("declares the agent and output-schema capabilities before setting a worker", () => {
    const source: JsonValue = {
      capabilities: ["quality"],
      nodes: [{ id: "repair", type: "pattern", uses: pattern.id }],
    }
    const catalog = library(
      [pattern, outputSchema],
      [
        capability("quality"),
        capability("model-execution", ["agent"]),
        capability("structured-output"),
      ],
    )
    const onOperations = renderInspector(source, catalog, [writer])

    fireEvent.change(screen.getByLabelText("Worker agent"), {
      target: { value: writer.id },
    })

    expect(onOperations).toHaveBeenCalledWith([
      {
        op: "sequence_insert",
        path: ["capabilities"],
        value: "model-execution",
      },
      {
        op: "sequence_insert",
        path: ["capabilities"],
        value: "structured-output",
      },
      {
        op: "set",
        path: ["nodes", 0, "worker"],
        value: writer.id,
      },
    ])
  })
})
