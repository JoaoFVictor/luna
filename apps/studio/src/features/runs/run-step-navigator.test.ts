import { describe, expect, it } from "vitest"

import { groupRunSteps } from "@/features/runs/run-step-navigator"
import type { WorkflowGraphModel } from "@/features/workflows/workflow-graph-model"
import type { WorkflowNodeExecution } from "@/features/workflows/workflow-execution-presentation"

const graph: WorkflowGraphModel = {
  nodes: [
    { id: "done", kind: "agent", capability_id: "agent", can_create_pending_interrupt: false },
    { id: "failed", kind: "built_in", capability_id: "publish", can_create_pending_interrupt: false },
    { id: "skipped", kind: "built_in", capability_id: "notify", can_create_pending_interrupt: false },
    { id: "unknown", kind: "agent", capability_id: "agent", can_create_pending_interrupt: false },
  ],
  edges: [],
}

describe("groupRunSteps", () => {
  it("groups every step by observed execution state without treating unknown as skipped", () => {
    const execution = new Map<string, WorkflowNodeExecution>([
      ["done", { status: "succeeded" }],
      ["failed", { status: "failed", primaryFailure: true }],
      ["skipped", { status: "skipped_dependency_failed" }],
    ])

    expect(groupRunSteps(graph, execution).map((group) => [
      group.id,
      group.nodes.map((node) => node.id),
    ])).toEqual([
      ["attention", ["failed"]],
      ["completed", ["done"]],
      ["not_run", ["skipped"]],
      ["unobserved", ["unknown"]],
    ])
  })
})
