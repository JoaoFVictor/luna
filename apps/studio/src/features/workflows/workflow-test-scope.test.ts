import { describe, expect, it } from "vitest"

import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"
import {
  workflowTestDataNodeIdsForScope,
  workflowTestScopeAvailability,
} from "@/features/workflows/workflow-test-scope"

const nodes: WorkflowSourceNode[] = [
  { id: "start", index: 0, type: "built_in", registrationId: "test.step", value: {} },
  { id: "parallel", index: 1, type: "built_in", registrationId: "test.step", value: {} },
  { id: "target", index: 2, type: "built_in", registrationId: "test.step", value: { after: ["start"] } },
  { id: "later", index: 3, type: "built_in", registrationId: "test.step", value: { after: ["target", "parallel"] } },
]

describe("workflow test scope", () => {
  it("requires every direct input to execute one node", () => {
    expect(workflowTestScopeAvailability(
      nodes,
      "later",
      "isolated_node",
      new Set(["target"]),
    )).toEqual({
      boundaryNodeIds: ["target", "parallel"],
      missingNodeIds: ["parallel"],
      available: false,
    })
  })

  it("requires every incoming boundary to execute from a node", () => {
    expect(workflowTestScopeAvailability(
      nodes,
      "target",
      "from_node",
      new Set(["start", "parallel"]),
    )).toEqual({
      boundaryNodeIds: ["start", "parallel"],
      missingNodeIds: [],
      available: true,
    })
  })

  it("selects only fixtures that belong to the requested execution scope", () => {
    expect([...workflowTestDataNodeIdsForScope(nodes, {
      kind: "through_node",
      node_id: "target",
    }) ?? []]).toEqual(["target", "start"])
    expect([...workflowTestDataNodeIdsForScope(nodes, {
      kind: "isolated_node",
      node_id: "later",
    }) ?? []]).toEqual(["target", "parallel"])
    expect(workflowTestDataNodeIdsForScope(nodes, { kind: "workflow" })).toBeUndefined()
  })
})
