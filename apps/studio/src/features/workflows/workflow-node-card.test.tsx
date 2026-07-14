import type { HTMLAttributes } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { WorkflowNodeCard } from "@/features/workflows/workflow-node-card"

vi.mock("@xyflow/react", () => ({
  Handle: ({ type, isConnectable, ...props }: HTMLAttributes<HTMLButtonElement> & { type: string; isConnectable?: boolean }) => (
    <button data-testid={`${type}-handle`} data-is-connectable={String(isConnectable ?? true)} {...props} />
  ),
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
}))

describe("WorkflowNodeCard connection handles", () => {
  it("activates source and target handles with the keyboard", () => {
    const onSource = vi.fn()
    const onTarget = vi.fn()
    render(
      <WorkflowNodeCard
        id="step"
        type="workflow-node"
        data={{
          compiled: {
            id: "step",
            kind: "built_in",
            capability_id: "test.step",
            can_create_pending_interrupt: false,
          },
          direction: "vertical",
          connectionSourceActive: true,
          onConnectionSourceClick: onSource,
          onConnectionTargetClick: onTarget,
        }}
        dragging={false}
        zIndex={1}
        selectable
        deletable={false}
        selected={false}
        draggable
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
    )

    fireEvent.keyDown(screen.getByTestId("source-handle"), { key: "Enter" })
    fireEvent.keyDown(screen.getByTestId("target-handle"), { key: " " })

    expect(onSource).toHaveBeenCalledOnce()
    expect(onTarget).toHaveBeenCalledOnce()
    expect(screen.getByTestId("source-handle").getAttribute("aria-pressed")).toBe("true")
  })

  it("keeps handle clicks from selecting the node underneath", () => {
    const onSource = vi.fn()
    const onCard = vi.fn()
    render(
      <div onClick={onCard}>
        <WorkflowNodeCard
          id="step"
          type="workflow-node"
          data={{
            compiled: { id: "step", kind: "built_in", capability_id: "test.step", can_create_pending_interrupt: false },
            direction: "vertical",
            onConnectionSourceClick: onSource,
          }}
          dragging={false}
          zIndex={1}
          selectable
          deletable={false}
          selected={false}
          draggable
          isConnectable
          positionAbsoluteX={0}
          positionAbsoluteY={0}
        />
      </div>,
    )

    fireEvent.click(screen.getByTestId("source-handle"))
    expect(onSource).toHaveBeenCalledOnce()
    expect(onCard).not.toHaveBeenCalled()
  })

  it("lets an inactive target handle select the node underneath", () => {
    const onCard = vi.fn()
    render(
      <div onClick={onCard}>
        <WorkflowNodeCard
          id="step"
          type="workflow-node"
          data={{
            compiled: { id: "step", kind: "built_in", capability_id: "test.step", can_create_pending_interrupt: false },
            direction: "vertical",
          }}
          dragging={false}
          zIndex={1}
          selectable
          deletable={false}
          selected={false}
          draggable
          isConnectable
          positionAbsoluteX={0}
          positionAbsoluteY={0}
        />
      </div>,
    )

    fireEvent.click(screen.getByTestId("target-handle"))
    expect(onCard).toHaveBeenCalledOnce()
  })

  it.each([
    ["active" as const, "Substituição ativa"],
    ["saved" as const, "Dados salvos"],
  ])("shows the %s test-data state on the canvas", (testDataState, label) => {
    render(
      <WorkflowNodeCard
        id="step"
        type="workflow-node"
        data={{
          compiled: {
            id: "step",
            kind: "built_in",
            capability_id: "test.step",
            can_create_pending_interrupt: false,
          },
          direction: "vertical",
          testDataState,
        }}
        dragging={false}
        zIndex={1}
        selectable
        deletable={false}
        selected={false}
        draggable
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
    )

    expect(screen.getByText(label)).toBeDefined()
  })

  it("offers an explicit branch action on a selected node and shows its fan-out", () => {
    const onAddBranch = vi.fn()
    render(
      <WorkflowNodeCard
        id="source"
        type="workflow-node"
        data={{
          compiled: {
            id: "source",
            kind: "built_in",
            capability_id: "test.source",
            can_create_pending_interrupt: false,
          },
          direction: "vertical",
          outgoingCount: 2,
          onAddBranch,
        }}
        dragging={false}
        zIndex={1}
        selectable
        deletable={false}
        selected
        draggable
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
    )

    expect(screen.getByText("2 ramos")).toBeDefined()
    fireEvent.click(screen.getByRole("button", {
      name: "Adicionar ramo a partir de source",
    }))
    expect(onAddBranch).toHaveBeenCalledOnce()
  })

  it("renders read-only data ports separately from control handles", () => {
    render(
      <WorkflowNodeCard
        id="transform"
        type="workflow-node"
        data={{
          compiled: {
            id: "transform",
            kind: "built_in",
            capability_id: "test.transform",
            can_create_pending_interrupt: false,
          },
          direction: "vertical",
          dataInputCount: 2,
          dataOutputCount: 1,
        }}
        dragging={false}
        zIndex={1}
        selectable
        deletable={false}
        selected={false}
        draggable
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
    )

    expect(screen.getByText("entrada · 2")).toBeDefined()
    expect(screen.getByText("saída · 1")).toBeDefined()
    expect(screen.getByRole("button", { name: "2 dados recebidos por transform" })
      .getAttribute("data-is-connectable")).toBe("false")
    expect(screen.getByRole("button", { name: "1 dado utilizado de transform" })
      .getAttribute("data-is-connectable")).toBe("false")
  })

  it("identifies a composed workflow as a subworkflow on the canvas", () => {
    render(
      <WorkflowNodeCard
        id="review"
        type="workflow-node"
        data={{
          compiled: {
            id: "review",
            kind: "workflow",
            capability_id: "workflow:review-child",
            can_create_pending_interrupt: false,
          },
          direction: "vertical",
          presentation: { title: "Review child" },
        }}
        dragging={false}
        zIndex={1}
        selectable
        deletable={false}
        selected={false}
        draggable
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
    )

    expect(screen.getByText("Review child")).toBeDefined()
    expect(screen.getByText("Subworkflow · review")).toBeDefined()
  })

  it("identifies a durable loop and exposes its body size", () => {
    render(
      <WorkflowNodeCard
        id="editorial"
        type="workflow-node"
        data={{
          compiled: {
            id: "editorial",
            kind: "loop",
            capability_id: "workflow.loop",
            can_create_pending_interrupt: true,
            loop_body: [
              { id: "draft", kind: "agent", capability_id: "writer", can_create_pending_interrupt: false },
              { id: "review", kind: "interrupt", capability_id: "hitl.approval", can_create_pending_interrupt: true },
            ],
          },
          direction: "vertical",
        }}
        dragging={false}
        zIndex={1}
        selectable
        deletable={false}
        selected={false}
        draggable
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
    )

    expect(screen.getByText("Loop durável · editorial")).toBeDefined()
    expect(screen.getByText("2 etapas internas")).toBeDefined()
    expect(screen.getByText("pode interromper")).toBeDefined()
  })
})
