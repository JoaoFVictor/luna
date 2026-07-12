import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { WorkflowMultiSelectionBar } from "@/features/workflows/workflow-multi-selection-bar"

describe("WorkflowMultiSelectionBar", () => {
  it("shows an objective count, clears directly, and confirms destructive deletion", () => {
    const onClear = vi.fn()
    const onDelete = vi.fn()
    const onDeleteOpenChange = vi.fn()
    const { rerender } = render(
      <WorkflowMultiSelectionBar
        count={3}
        canDelete
        deleteOpen={false}
        onDeleteOpenChange={onDeleteOpenChange}
        onClear={onClear}
        onDelete={onDelete}
      />,
    )

    expect(screen.getByRole("toolbar", { name: "Ações para 3 passos selecionados" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Limpar seleção" }))
    fireEvent.click(screen.getByRole("button", { name: "Excluir" }))
    expect(onClear).toHaveBeenCalledOnce()
    expect(onDeleteOpenChange).toHaveBeenCalledWith(true)
    expect(onDelete).not.toHaveBeenCalled()

    rerender(
      <WorkflowMultiSelectionBar
        count={3}
        canDelete
        deleteOpen
        onDeleteOpenChange={onDeleteOpenChange}
        onClear={onClear}
        onDelete={onDelete}
      />,
    )
    expect(screen.getByText("As dependências dos passos restantes serão atualizadas automaticamente.", { exact: false })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Excluir 3 passos" }))
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it("explains when the atomic operation limit prevents deletion", () => {
    render(
      <WorkflowMultiSelectionBar
        count={60}
        canDelete={false}
        deleteUnavailableReason="Esta seleção exige 70 operações, acima do limite de 64. Selecione menos passos."
        deleteOpen={false}
        onDeleteOpenChange={vi.fn()}
        onClear={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: "Excluir" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("status").textContent).toContain("acima do limite de 64")
  })
})
