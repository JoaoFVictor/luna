import { describe, expect, it } from "vitest"

import { workflowCanvasLayout, workflowNodeNotes, withWorkflowCanvasLayout, withWorkflowNodeNote } from "@/features/workflows/workflow-layout"

describe("workflow node notes", () => {
  it("stores presentation-only notes without replacing other layout data", () => {
    const layout = withWorkflowNodeNote({ workflow: { positions: { one: { x: 1, y: 2 } } } }, "one", "Revisar este passo")
    expect(workflowNodeNotes(layout)).toEqual({ one: "Revisar este passo" })
    expect(layout).toMatchObject({ workflow: { positions: { one: { x: 1, y: 2 } } } })
  })

  it("removes an empty note", () => {
    expect(withWorkflowNodeNote({ workflow: { notes: { one: "old" } } }, "one", " ")).toEqual({ workflow: {} })
  })
})

describe("workflow canvas layout", () => {
  it("reads legacy layouts with safe defaults", () => {
    expect(workflowCanvasLayout({ workflow: { positions: { one: { x: 1, y: 2 } } } })).toEqual({
      positions: { one: { x: 1, y: 2 } },
      direction: "vertical",
      pinnedNodeIds: [],
      groups: [],
    })
  })

  it("persists direction and deduplicated pins atomically", () => {
    const layout = withWorkflowCanvasLayout({ workflow: { notes: { one: "note" } } }, {
      positions: { one: { x: 10, y: 20 } },
      direction: "horizontal",
      pinnedNodeIds: ["one", "one"],
      groups: [{ id: "review", title: "Revisão", nodeIds: ["one", "one"] }],
    })
    expect(layout).toEqual({ workflow: {
      notes: { one: "note" },
      positions: { one: { x: 10, y: 20 } },
      direction: "horizontal",
      pinned_nodes: ["one"],
      groups: [{ id: "review", title: "Revisão", node_ids: ["one"] }],
    } })
  })

  it("drops malformed and duplicate group ids before they reach React Flow", () => {
    expect(workflowCanvasLayout({ workflow: { groups: [
      { id: "review", title: " Review ", node_ids: ["one", "one"] },
      { id: "review", title: "duplicate", node_ids: ["two"] },
      { id: "", title: "invalid", node_ids: [] },
    ] } }).groups).toEqual([{ id: "review", title: "Review", nodeIds: ["one"] }])
  })
})
