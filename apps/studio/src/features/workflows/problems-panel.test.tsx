import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { ValidationDiagnostic } from "@/api/types"
import { ProblemsPanel } from "@/features/workflows/problems-panel"

const diagnostic = {
  severity: "error",
  code: "workflow_schema_invalid",
  message: "O input é inválido.",
  resource: { kind: "workflow", id: "review" },
  field_path: "$.nodes[8].input.prompt",
  node_id: "review",
  node_field_path: ["input", "prompt"],
} satisfies ValidationDiagnostic

describe("ProblemsPanel", () => {
  it("offers a contextual action for an authoritative node field", () => {
    const onOpenDiagnostic = vi.fn()
    render(
      <ProblemsPanel
        diagnostics={[diagnostic]}
        validated
        onOpenDiagnostic={onOpenDiagnostic}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /abrir campo/i }))
    expect(onOpenDiagnostic).toHaveBeenCalledWith(diagnostic)
  })

  it("keeps resource-only diagnostics without a misleading action", () => {
    render(
      <ProblemsPanel
        diagnostics={[{
          ...diagnostic,
          node_id: undefined,
          node_field_path: undefined,
        }]}
        validated
        onOpenDiagnostic={vi.fn()}
      />,
    )

    expect(screen.queryByRole("button", { name: /abrir/i })).toBeNull()
  })
})
