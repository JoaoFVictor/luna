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
      connectOnClick: false,
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
      edge: { id: string; type: string },
    ) => void
    act(() => clickEdge({}, { id: "source:target:0", type: "workflow-dependency" }))

    const edges = captured.props?.edges as Array<{ id: string; selected: boolean }>
    expect(edges[0]).toMatchObject({ id: "source:target:0", selected: true })
  })

  it("reports rejected connections for both drag and accessible click modes", () => {
    const onInvalidConnection = vi.fn()
    render(
      <WorkflowGraph
        graph={{
          nodes: [
            { id: "source", kind: "built_in", capability_id: "one", can_create_pending_interrupt: false },
            { id: "target", kind: "built_in", capability_id: "two", can_create_pending_interrupt: false },
          ],
          edges: [],
        }}
        onConnectNodes={vi.fn()}
        isValidConnection={() => false}
        onInvalidConnection={onInvalidConnection}
      />,
    )
    const rejectedDrag = {
      isValid: false,
      fromNode: { id: "source" },
      toNode: { id: "target" },
    }
    const onConnectEnd = captured.props?.onConnectEnd
    if (typeof onConnectEnd !== "function") {
      throw new Error("Expected the React Flow drag completion handler")
    }
    onConnectEnd({}, rejectedDrag)
    let nodes = captured.props?.nodes as Array<{
      id: string
      data: {
        onConnectionSourceClick?: () => void
        onConnectionTargetClick?: () => void
      }
    }>
    act(() => nodes.find((node) => node.id === "source")?.data.onConnectionSourceClick?.())
    nodes = captured.props?.nodes as typeof nodes
    nodes.find((node) => node.id === "target")?.data.onConnectionTargetClick?.()

    expect(onInvalidConnection).toHaveBeenNthCalledWith(1, "source", "target")
    expect(onInvalidConnection).toHaveBeenNthCalledWith(2, "source", "target")
  })

  it("opens quick-add when a drag or click connection ends on the canvas", () => {
    const onConnectToEmpty = vi.fn()
    render(
      <WorkflowGraph
        graph={{
          nodes: [
            { id: "source", kind: "built_in", capability_id: "one", can_create_pending_interrupt: false },
          ],
          edges: [],
        }}
        onConnectNodes={vi.fn()}
        onConnectToEmpty={onConnectToEmpty}
      />,
    )

    const onConnectEnd = captured.props?.onConnectEnd
    if (typeof onConnectEnd !== "function") throw new Error("Expected a drag completion handler")

    onConnectEnd({}, {
      isValid: false,
      fromNode: { id: "source" },
      toNode: null,
    })
    let nodes = captured.props?.nodes as Array<{
      id: string
      data: { onConnectionSourceClick?: () => void }
    }>
    act(() => nodes.find((node) => node.id === "source")?.data.onConnectionSourceClick?.())
    nodes = captured.props?.nodes as typeof nodes
    expect(nodes[0]?.data).toMatchObject({ connectionSourceActive: true })
    const onPaneClick = captured.props?.onPaneClick
    if (typeof onPaneClick !== "function") throw new Error("Expected a pane click handler")
    act(() => onPaneClick())

    expect(onConnectToEmpty).toHaveBeenNthCalledWith(1, "source")
    expect(onConnectToEmpty).toHaveBeenNthCalledWith(2, "source")
  })

  it("projects fan-out as labeled visual branches and exposes quick-add on the source node", () => {
    const onAddBranch = vi.fn()
    render(
      <WorkflowGraph
        graph={{
          nodes: [
            { id: "source", kind: "built_in", capability_id: "one", can_create_pending_interrupt: false },
            { id: "left", kind: "built_in", capability_id: "two", can_create_pending_interrupt: false },
            { id: "right", kind: "built_in", capability_id: "three", can_create_pending_interrupt: false },
          ],
          edges: [
            { from: "source", to: "left" },
            { from: "source", to: "right" },
          ],
        }}
        selectedNodeId="source"
        onConnectNodes={vi.fn()}
        onConnectToEmpty={onAddBranch}
      />,
    )

    const nodes = captured.props?.nodes as Array<{
      id: string
      data: { outgoingCount?: number; onAddBranch?: () => void }
    }>
    expect(nodes.find((node) => node.id === "source")?.data.outgoingCount).toBe(2)
    act(() => nodes.find((node) => node.id === "source")?.data.onAddBranch?.())
    expect(onAddBranch).toHaveBeenCalledWith("source")

    const edges = captured.props?.edges as Array<{
      data: { branchLabel?: string }
      ariaLabel: string
    }>
    expect(edges.map((edge) => edge.data.branchLabel)).toEqual([
      "Para left",
      "Para right",
    ])
    expect(edges[1]?.ariaLabel).toContain("ramo para right")
  })

  it("supports Ctrl, Cmd, and Shift additive node selection without changing a plain click", () => {
    const onSelectNode = vi.fn()
    render(
      <WorkflowGraph
        graph={{
          nodes: [
            { id: "one", kind: "built_in", capability_id: "first", can_create_pending_interrupt: false },
            { id: "two", kind: "built_in", capability_id: "second", can_create_pending_interrupt: false },
          ],
          edges: [],
        }}
        selectedNodeId="one"
        selectedNodeIds={["one", "two"]}
        onSelectNode={onSelectNode}
      />,
    )

    expect(captured.props?.multiSelectionKeyCode).toEqual(["Meta", "Control", "Shift"])
    const projected = captured.props?.nodes as Array<{ id: string; selected: boolean }>
    expect(projected.map((node) => [node.id, node.selected])).toEqual([
      ["one", true],
      ["two", true],
    ])
    const click = captured.props?.onNodeClick as (
      event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
      node: { id: string; type: string },
    ) => void
    click({ metaKey: false, ctrlKey: false, shiftKey: false }, { id: "one", type: "workflow-node" })
    click({ metaKey: false, ctrlKey: true, shiftKey: false }, { id: "two", type: "workflow-node" })
    click({ metaKey: true, ctrlKey: false, shiftKey: false }, { id: "one", type: "workflow-node" })
    click({ metaKey: false, ctrlKey: false, shiftKey: true }, { id: "two", type: "workflow-node" })

    expect(onSelectNode.mock.calls).toEqual([
      ["one", false],
      ["two", true],
      ["one", true],
      ["two", true],
    ])
  })

  it("keeps canonical data mappings visually and semantically separate from after edges", () => {
    const onSelectNode = vi.fn()
    render(
      <WorkflowGraph
        graph={{
          nodes: [
            { id: "collect", kind: "built_in", capability_id: "collect", can_create_pending_interrupt: false },
            { id: "publish", kind: "built_in", capability_id: "publish", can_create_pending_interrupt: false },
          ],
          edges: [{ from: "collect", to: "publish" }],
        }}
        dataConnections={[{
          sourceId: "collect",
          targetId: "publish",
          mappings: [
            { expression: "$.steps.collect.title", sourcePath: ["title"], targetPath: ["title"] },
            { expression: "$.steps.collect.body", sourcePath: ["body"], targetPath: ["content"] },
          ],
        }]}
        onSelectNode={onSelectNode}
      />,
    )

    const nodes = captured.props?.nodes as Array<{
      id: string
      data: { dataInputCount?: number; dataOutputCount?: number }
      ariaLabel: string
    }>
    expect(nodes.find((node) => node.id === "collect")?.data.dataOutputCount).toBe(2)
    expect(nodes.find((node) => node.id === "publish")?.data.dataInputCount).toBe(2)

    const edges = captured.props?.edges as Array<{
      id: string
      type: string
      sourceHandle?: string
      targetHandle?: string
      selectable: boolean
      deletable: boolean
      reconnectable?: boolean
      ariaLabel: string
    }>
    expect(edges).toHaveLength(2)
    expect(edges[0]).toMatchObject({
      type: "workflow-dependency",
      ariaLabel: "collect executa antes de publish",
    })
    expect(edges[1]).toMatchObject({
      type: "workflow-data",
      sourceHandle: "workflow-data-output",
      targetHandle: "workflow-data-input",
      selectable: false,
      deletable: false,
      reconnectable: false,
      ariaLabel: "Dados diretos de collect para publish: 2 campos mapeados",
    })

    const clickEdge = captured.props?.onEdgeClick as (
      event: unknown,
      edge: { id: string; type: string },
    ) => void
    act(() => clickEdge({}, { id: edges[1]!.id, type: "workflow-data" }))
    expect(onSelectNode).not.toHaveBeenCalled()
    const projectedAfterClick = captured.props?.edges as Array<{
      id: string
      selected: boolean
    }>
    expect(projectedAfterClick.find((edge) => edge.id === edges[1]!.id)?.selected).toBe(false)
  })
})
