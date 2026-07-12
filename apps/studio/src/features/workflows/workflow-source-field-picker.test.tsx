import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { WorkflowSourceFieldPicker } from "@/features/workflows/workflow-source-field-picker"
import {
  WORKFLOW_FIELD_DRAG_MIME,
  parseWorkflowFieldDragPayload,
} from "@/features/workflows/workflow-field-drag"

const suggestions = [
  { value: "$.invocation", label: "Entrada do workflow", valueType: "unknown", compatible: true },
  { value: "$.steps.context.repository.root", label: "context › repository.root", valueType: "string", compatible: true },
  { value: "$.steps.context.repository.read", label: "context › repository.read", valueType: "array", compatible: false },
]

describe("WorkflowSourceFieldPicker", () => {
  it("filters available data and selects a compatible field", () => {
    const onSelect = vi.fn()
    render(
      <WorkflowSourceFieldPicker
        suggestions={suggestions}
        selectedValue="$.invocation"
        disabled={false}
        onSelect={onSelect}
      />,
    )

    fireEvent.change(screen.getByRole("textbox", { name: "Buscar dados anteriores" }), {
      target: { value: "repository.root" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Usar context › repository.root" }))

    expect(onSelect).toHaveBeenCalledWith("$.steps.context.repository.root")
    expect(screen.queryByRole("button", { name: "Usar Entrada do workflow" })).toBeNull()
  })

  it("keeps incompatible fields visible but disabled", () => {
    render(
      <WorkflowSourceFieldPicker
        suggestions={suggestions}
        selectedValue="$.invocation"
        disabled={false}
        onSelect={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: "Usar context › repository.read" }).hasAttribute("disabled")).toBe(true)
  })

  it("publishes the versioned Luna mapping payload while dragging", () => {
    const values = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: "uninitialized",
      setData: (type: string, value: string) => values.set(type, value),
    }
    render(
      <WorkflowSourceFieldPicker
        suggestions={suggestions}
        selectedValue="$.invocation"
        disabled={false}
        onSelect={vi.fn()}
      />,
    )

    fireEvent.dragStart(
      screen.getByRole("button", { name: "Usar context › repository.root" }),
      { dataTransfer },
    )

    expect(parseWorkflowFieldDragPayload(values.get(WORKFLOW_FIELD_DRAG_MIME) ?? ""))
      .toBe("$.steps.context.repository.root")
    expect(values.get("text/plain")).toBe("$.steps.context.repository.root")
    expect(dataTransfer.effectAllowed).toBe("copy")
  })
})
