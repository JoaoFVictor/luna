import { describe, expect, it } from "vitest"
import { elkWorkflowPositions } from "./workflow-elk-layout"

const graph = {
  nodes: [{ id: "start" }, { id: "middle" }, { id: "end" }],
  edges: [{ from: "start", to: "middle" }, { from: "middle", to: "end" }],
}

describe("ELK workflow layout", () => {
  it("lays a workflow in the selected direction", async () => {
    const positions = await elkWorkflowPositions(graph, { positions: {}, direction: "horizontal", pinnedNodeIds: [], groups: [] })
    expect(positions.start?.x).toBeLessThan(positions.middle?.x ?? 0)
    expect(positions.middle?.x).toBeLessThan(positions.end?.x ?? 0)
  })

  it("preserves positions explicitly fixed by the author", async () => {
    const positions = await elkWorkflowPositions(graph, {
      positions: { middle: { x: 900, y: 700 } },
      direction: "vertical",
      pinnedNodeIds: ["middle"],
      groups: [],
    })
    expect(positions.middle).toEqual({ x: 900, y: 700 })
  })
})
