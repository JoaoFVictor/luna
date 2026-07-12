import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { WorkflowGroupManager } from "@/features/workflows/workflow-group-manager"

describe("WorkflowGroupManager", () => {
  it("keeps typing local and persists the complete group edit only on save", () => {
    const onChange = vi.fn()
    render(
      <WorkflowGroupManager
        groups={[]}
        nodes={[{ id: "analyze", title: "Analisar" }]}
        disabled={false}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Grupos" }))
    fireEvent.click(screen.getByRole("button", { name: "Criar grupo" }))
    const title = screen.getByLabelText("Nome do grupo")
    fireEvent.change(title, { target: { value: "Revisão principal" } })
    fireEvent.click(screen.getByText("Analisar"))

    expect(onChange).not.toHaveBeenCalled()
    expect((title as HTMLInputElement).value).toBe("Revisão principal")

    fireEvent.click(screen.getByRole("button", { name: "Salvar grupos" }))
    expect(onChange).toHaveBeenCalledWith([{
      id: "group-1",
      title: "Revisão principal",
      nodeIds: ["analyze"],
    }])
  })
})
