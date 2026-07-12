import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { workflowSourceOutlineEntries } from "@/features/workflows/workflow-source-model"
import { WorkflowSourceOutline } from "@/features/workflows/workflow-source-outline"

describe("WorkflowSourceOutline", () => {
  it("keeps malformed nodes keyboard reachable and selectable", () => {
    const entries = workflowSourceOutlineEntries({
      nodes: [
        { id: "valid", type: "built_in", uses: "runtime.preflight" },
        { type: "agent" },
        42,
      ],
    })
    const onSelect = vi.fn()
    render(
      <WorkflowSourceOutline
        entries={entries}
        selectedEntryId="valid"
        onSelectEntry={onSelect}
      />,
    )

    const valid = screen.getByRole("button", { name: /valid/u })
    const missingId = screen.getByRole("button", { name: /Node 2 \(id ausente\)/u })
    const rawNumber = screen.getByRole("button", { name: /Node 3 \(id ausente\)/u })

    valid.focus()
    fireEvent.keyDown(valid, { key: "ArrowDown" })
    expect(document.activeElement).toBe(missingId)
    fireEvent.keyDown(missingId, { key: "End" })
    expect(document.activeElement).toBe(rawNumber)

    fireEvent.click(rawNumber)
    expect(onSelect).toHaveBeenCalledWith("source-node:2")
  })
})
