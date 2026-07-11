import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { CompiledWorkflow } from "@/api/types"
import { WorkflowOutline } from "@/features/workflows/workflow-graph"

const compiled: CompiledWorkflow = {
  workflow_id: "keyboard-flow",
  workflow_revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  state_schema_version: "1",
  nodes: [
    { id: "first", kind: "built_in", yaml_path: "$.nodes[0]", capability_id: "runtime.preflight", can_create_pending_interrupt: false },
    { id: "second", kind: "agent", yaml_path: "$.nodes[1]", capability_id: "reviewer", can_create_pending_interrupt: false },
    { id: "third", kind: "pattern", yaml_path: "$.nodes[2]", capability_id: "quality-gates.gated_agent_loop", can_create_pending_interrupt: false },
  ],
  edges: [
    { from: "first", to: "second" },
    { from: "second", to: "third" },
  ],
}

describe("WorkflowOutline keyboard navigation", () => {
  it("moves focus with arrows, Home, and End without requiring the canvas", () => {
    render(<WorkflowOutline compiled={compiled} onSelectNode={vi.fn()} />)
    const buttons = screen.getAllByRole("button")
    buttons[0]!.focus()

    fireEvent.keyDown(buttons[0]!, { key: "ArrowDown" })
    expect(document.activeElement).toBe(buttons[1])
    fireEvent.keyDown(buttons[1]!, { key: "End" })
    expect(document.activeElement).toBe(buttons[2])
    fireEvent.keyDown(buttons[2]!, { key: "Home" })
    expect(document.activeElement).toBe(buttons[0])
    fireEvent.keyDown(buttons[0]!, { key: "ArrowUp" })
    expect(document.activeElement).toBe(buttons[0])
  })

  it("announces persisted execution status, attempts, artifacts, and primary failure", () => {
    render(
      <WorkflowOutline
        compiled={compiled}
        execution={new Map([
          [
            "second",
            {
              status: "failed" as const,
              attemptCount: 2,
              artifactCount: 1,
              primaryFailure: true,
            },
          ],
        ])}
        onSelectNode={vi.fn()}
      />,
    )

    const failed = screen.getByRole("button", {
      name: /second, reviewer, Falhou, 2 tentativas, 1 resultado, falha principal/i,
    })
    expect(failed).toBeDefined()
    expect(screen.getByText("Falhou")).toBeDefined()
    expect(screen.getByText("2 tentativas")).toBeDefined()
    expect(screen.getByText("1 resultado")).toBeDefined()
    expect(screen.getByText("Falha principal")).toBeDefined()
  })
})
