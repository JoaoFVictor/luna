import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { DraftItem, DraftValidationResult } from "@/api/types"
import { WorkflowEditorHeader } from "@/features/workflows/workflow-editor-header"

const draft = {
  draft_id: "7cb66a75-e723-4eee-adbd-54325db3030e",
  record_revision: 1,
  content_revision: 1,
  layout_revision: 0,
  primary_resource: { kind: "workflow", id: "review" },
  status: "valid",
  draft_hash: `sha256:${"a".repeat(64)}`,
  etag: '"draft-1"',
  files: [],
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
} satisfies DraftItem

function validationResult(
  status: DraftValidationResult["status"],
  compiled: boolean,
): DraftValidationResult {
  return {
    draft_id: draft.draft_id,
    record_revision: draft.record_revision,
    content_revision: draft.content_revision,
    layout_revision: draft.layout_revision,
    draft_hash: draft.draft_hash,
    status,
    compiled,
    resources: [],
    diagnostics: [],
    validated_at: "2026-07-12T00:00:01.000Z",
  }
}

function renderHeader(validation: DraftValidationResult | undefined) {
  render(<WorkflowEditorHeader
    draft={draft}
    validation={validation}
    hasLocalChanges={false}
    canMutate
    saving={false}
    validating={false}
    compiling={false}
    planning={false}
    canUndo={false}
    canRedo={false}
    onUndo={vi.fn()}
    onRedo={vi.fn()}
    onTest={vi.fn()}
    onPlanApply={vi.fn()}
  />)
}

describe("WorkflowEditorHeader", () => {
  it("blocks testing until the saved draft has a valid compiled result", () => {
    renderHeader(validationResult("invalid", false))

    const test = screen.getByRole("button", { name: "Testar" })
    expect((test as HTMLButtonElement).disabled).toBe(true)
    expect(test.getAttribute("title")).toBe("Corrija os problemas do workflow antes de testar")
  })

  it("allows testing a valid compiled saved draft", () => {
    renderHeader(validationResult("valid", true))

    expect((screen.getByRole("button", { name: "Testar" }) as HTMLButtonElement).disabled).toBe(false)
  })
})
