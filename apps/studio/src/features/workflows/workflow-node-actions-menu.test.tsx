import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { WorkflowNodeActionsMenu } from "./workflow-node-actions-menu"

describe("WorkflowNodeActionsMenu", () => {
  it("groups secondary actions, runs one action, and closes the menu", () => {
    const onDuplicate = vi.fn()
    const view = render(
      <WorkflowNodeActionsMenu
        pinned={false}
        canMutate
        canPaste
        onCopy={vi.fn()}
        onDuplicate={onDuplicate}
        onTogglePin={vi.fn()}
        onPaste={vi.fn()}
        onDelete={vi.fn()}
        onTestIsolated={vi.fn()}
        onTestFromHere={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText("Ações"))
    const details = view.container.querySelector("details")
    expect(details?.open).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: "Duplicar passo" }))
    expect(onDuplicate).toHaveBeenCalledOnce()
    expect(details?.open).toBe(false)
  })

  it("keeps mutating actions disabled in read-only mode", () => {
    render(
      <WorkflowNodeActionsMenu
        pinned
        canMutate={false}
        canPaste
        onCopy={vi.fn()}
        onDuplicate={vi.fn()}
        onTogglePin={vi.fn()}
        onPaste={vi.fn()}
        onDelete={vi.fn()}
        onTestIsolated={vi.fn()}
        onTestFromHere={vi.fn()}
      />,
    )

    expect((screen.getByRole("button", { name: "Duplicar passo" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Liberar posição" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Colar depois" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Excluir passo" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Copiar passo" }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("explains when saved outputs do not cover a scoped execution", () => {
    const onTestIsolated = vi.fn()
    render(
      <WorkflowNodeActionsMenu
        pinned={false}
        canMutate
        canPaste={false}
        onCopy={vi.fn()}
        onDuplicate={vi.fn()}
        onTogglePin={vi.fn()}
        onPaste={vi.fn()}
        onDelete={vi.fn()}
        onTestIsolated={onTestIsolated}
        onTestFromHere={vi.fn()}
        isolatedTestUnavailableReason="Ative dados salvos para analyze"
      />,
    )

    const isolated = screen.getByRole("button", { name: "Executar somente este" }) as HTMLButtonElement
    expect(isolated.disabled).toBe(true)
    expect(isolated.title).toBe("Ative dados salvos para analyze")
    fireEvent.click(isolated)
    expect(onTestIsolated).not.toHaveBeenCalled()
    expect((screen.getByRole("button", { name: "Executar daqui em diante" }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("requires confirmation before deleting a step", () => {
    const onDelete = vi.fn()
    render(
      <WorkflowNodeActionsMenu
        pinned={false}
        canMutate
        canPaste={false}
        onCopy={vi.fn()}
        onDuplicate={vi.fn()}
        onTogglePin={vi.fn()}
        onPaste={vi.fn()}
        onDelete={onDelete}
        onTestIsolated={vi.fn()}
        onTestFromHere={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Excluir passo" }))
    const dialog = screen.getByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Excluir passo" }))
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it("explains and blocks deletion when its atomic batch exceeds the API limit", () => {
    const onDelete = vi.fn()
    render(
      <WorkflowNodeActionsMenu
        pinned={false}
        canMutate
        canPaste={false}
        onCopy={vi.fn()}
        onDuplicate={vi.fn()}
        onTogglePin={vi.fn()}
        onPaste={vi.fn()}
        onDelete={onDelete}
        onTestIsolated={vi.fn()}
        onTestFromHere={vi.fn()}
        deleteUnavailableReason="Este passo exige 65 operações; limite de 64."
      />,
    )

    const remove = screen.getByRole("button", { name: "Excluir passo" }) as HTMLButtonElement
    expect(remove.disabled).toBe(true)
    expect(remove.title).toContain("limite de 64")
    expect(screen.getByRole("status").textContent).toContain("65 operações")
    fireEvent.click(remove)
    expect(onDelete).not.toHaveBeenCalled()
  })
})
