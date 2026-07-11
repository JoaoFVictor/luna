import type { ReactNode } from "react"
import { act, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { WorkflowGraph } from "@/features/workflows/workflow-graph"

const captured = vi.hoisted(() => ({
  props: undefined as undefined | Record<string, unknown>,
}))

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
  MiniMap: () => null,
  Position: { Top: "top", Bottom: "bottom" },
  ReactFlow: (props: Record<string, unknown> & { children?: ReactNode }) => {
    captured.props = props
    return <div>{props.children}</div>
  },
}))

describe("WorkflowGraph accessibility contract", () => {
  it("keeps nodes and edges focusable with localized keyboard guidance", () => {
    render(
      <WorkflowGraph
        graph={{
          nodes: [
            {
              id: "review",
              kind: "agent",
              capability_id: "reviewer",
              can_create_pending_interrupt: false,
            },
            {
              id: "publish",
              kind: "built_in",
              capability_id: "artifact.publish",
              can_create_pending_interrupt: false,
            },
          ],
          edges: [{ from: "review", to: "publish" }],
        }}
        execution={new Map([
          ["review", { status: "running" as const, attemptCount: 1 }],
        ])}
      />,
    )

    expect(captured.props).toMatchObject({
      nodesFocusable: true,
      edgesFocusable: true,
      disableKeyboardA11y: false,
    })
    const nodes = captured.props?.nodes as Array<{
      focusable: boolean
      ariaLabel: string
    }>
    const edges = captured.props?.edges as Array<{
      focusable: boolean
      ariaLabel: string
    }>
    expect(nodes[0]).toMatchObject({
      focusable: true,
      ariaLabel: expect.stringContaining("Em execução, 1 tentativa"),
    })
    expect(edges[0]).toMatchObject({
      focusable: true,
      ariaLabel: "review executa antes de publish",
    })
    const aria = captured.props?.ariaLabelConfig as Record<string, unknown>
    expect(aria["controls.zoomIn.ariaLabel"]).toBe("Aumentar zoom")
    expect(aria["node.a11yDescription.default"]).toContain("Pressione Enter")
  })

  it("keeps the clicked edge selected so its contextual actions can render", () => {
    render(
      <WorkflowGraph
        graph={{
          nodes: [
            { id: "source", kind: "built_in", capability_id: "one", can_create_pending_interrupt: false },
            { id: "target", kind: "built_in", capability_id: "two", can_create_pending_interrupt: false },
          ],
          edges: [{ from: "source", to: "target" }],
        }}
        onDeleteDependency={vi.fn()}
      />,
    )

    const clickEdge = captured.props?.onEdgeClick as (
      event: unknown,
      edge: { id: string },
    ) => void
    act(() => clickEdge({}, { id: "source:target:0" }))

    const edges = captured.props?.edges as Array<{ id: string; selected: boolean }>
    expect(edges[0]).toMatchObject({ id: "source:target:0", selected: true })
  })
})
