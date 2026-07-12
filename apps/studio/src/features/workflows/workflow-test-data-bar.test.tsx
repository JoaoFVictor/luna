import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import { WorkflowTestDataBar, type WorkflowTestDataControls } from "@/features/workflows/workflow-test-data-bar"
import type { WorkflowTestDataEntry } from "@/features/workflows/workflow-test-data-model"

const DIGEST = `sha256:${"a".repeat(64)}`
const entries: readonly WorkflowTestDataEntry[] = [
  {
    name: "manual",
    value: { input: "example" },
    eligibility: { kind: "preview_only", reason: "manual" },
    redacted: false,
  },
  {
    name: "approved-review",
    value: { output: "[REDACTED]" },
    eligibility: { kind: "preview_only", reason: "redacted" },
    redacted: true,
    source: {
      kind: "run_node_output",
      run_id: "run-1",
      workflow_id: "code-review",
      node_id: "review",
      graph_hash: DIGEST,
      outcome_hash: DIGEST,
      workflow_revision: DIGEST,
      definition_bundle_hash: DIGEST,
      captured_at: "2026-07-12T12:00:00.000Z",
      redaction_changed: true,
      definition_source: { kind: "installed" },
    },
  },
]

const eligibleEntry: WorkflowTestDataEntry = {
  name: "review-output",
  value: { summary: "Tudo certo", score: 10 },
  eligibility: { kind: "eligible", nodeId: "review" },
  redacted: false,
  source: {
    kind: "run_node_output",
    run_id: "run-2",
    workflow_id: "code-review",
    node_id: "review",
    graph_hash: DIGEST,
    outcome_hash: DIGEST,
    workflow_revision: DIGEST,
    definition_bundle_hash: DIGEST,
    captured_at: "2026-07-12T12:00:00.000Z",
    redaction_changed: false,
    definition_source: { kind: "installed" },
  },
}

function controls(overrides: Partial<WorkflowTestDataControls> = {}): WorkflowTestDataControls {
  return {
    entries,
    activeFixtureNames: new Set(),
    nodeStates: new Map([["review", "saved"]]),
    panelOpen: true,
    disabled: false,
    onOpenChange: vi.fn(),
    onToggle: vi.fn(),
    onPreview: vi.fn(),
    onClearAll: vi.fn(),
    onRemove: vi.fn(),
    onEdit: vi.fn(async () => undefined),
    onDespin: vi.fn(),
    ...overrides,
  }
}

describe("WorkflowTestDataBar", () => {
  it("lists every fixture, provenance, eligibility, redaction, and active selection", () => {
    const state = controls({ previewFixtureName: "approved-review" })
    render(<MemoryRouter><WorkflowTestDataBar controls={state} /></MemoryRouter>)

    expect(screen.getAllByText("manual").length).toBeGreaterThan(0)
    expect(screen.getAllByText("approved-review").length).toBeGreaterThan(0)
    expect(screen.getByText("Criado manualmente no editor")).toBeDefined()
    expect(screen.getByText("Capturado do node review")).toBeDefined()
    expect(screen.getByText("Preview apenas")).toBeDefined()
    expect(screen.getByText("Redigido · preview apenas")).toBeDefined()
    expect(screen.getByText("redigido")).toBeDefined()
    expect(screen.getByRole("link", { name: "Abrir execução" }).getAttribute("href")).toBe("/runs/run-1")

    fireEvent.click(screen.getByRole("button", { name: "Usar somente no preview" }))
    fireEvent.click(screen.getByRole("button", { name: "Remover dados de preview manual" }))
    expect(state.onPreview).toHaveBeenCalledWith(entries[0])
    expect(state.onRemove).toHaveBeenCalledWith("manual")
  })

  it("keeps selection available but prevents removal in read-only mode", () => {
    render(<MemoryRouter><WorkflowTestDataBar controls={controls({ disabled: true })} /></MemoryRouter>)

    expect(screen.getAllByRole("button", { name: "Usar somente no preview" }))
      .toHaveLength(entries.length)
    expect(screen.getByRole("button", { name: "Remover dados de preview manual" }).getAttribute("disabled")).not.toBeNull()
  })

  it("summarizes fields, collapses technical JSON, and explains an executable substitution", () => {
    const state = controls({
      entries: [eligibleEntry],
      activeFixtureNames: new Set(["review-output"]),
      previewFixtureName: "review-output",
    })
    render(<MemoryRouter><WorkflowTestDataBar controls={state} /></MemoryRouter>)

    expect(screen.getByText("2 campos")).toBeTruthy()
    expect(screen.getByText("summary")).toBeTruthy()
    expect(screen.getByText("score")).toBeTruthy()
    expect(screen.getByText("Ver JSON técnico").closest("details")?.open).toBe(false)
    expect(screen.getByText((_, element) =>
      element?.tagName === "P" && /review.*será pulado/u.test(element.textContent ?? ""),
    )).toBeTruthy()
    expect(screen.getAllByText("Substituição ativa").length).toBeGreaterThan(0)
    expect(screen.queryByText("Ativo no preview")).toBeNull()
    expect(screen.getByRole("button", { name: "Não substituir este node" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("edits explicit node JSON and can despin authorization without deleting preview", async () => {
    const editableEntry: WorkflowTestDataEntry = {
      ...eligibleEntry,
      value: {
        invocation: {},
        config: {},
        steps: { review: { summary: "Tudo certo", score: 10 } },
        workspace: {},
      },
    }
    const state = controls({ entries: [editableEntry] })
    render(<MemoryRouter><WorkflowTestDataBar controls={state} /></MemoryRouter>)

    fireEvent.click(screen.getByRole("button", { name: "Editar JSON" }))
    const editor = screen.getByRole("textbox", { name: "JSON do output fixado review-output" })
    fireEvent.change(editor, { target: { value: '{"summary":"ajustado","score":9}' } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar output de teste" }))
    await waitFor(() => expect(state.onEdit).toHaveBeenCalledWith(editableEntry, {
        summary: "ajustado",
        score: 9,
      }))

    fireEvent.click(screen.getByRole("button", { name: "Desvincular autorização" }))
    expect(state.onDespin).toHaveBeenCalledWith(editableEntry)
    expect(state.onRemove).not.toHaveBeenCalled()
  })

  it("preserves edited JSON when the server rejects schema, secret, or CAS validation", async () => {
    const editableEntry: WorkflowTestDataEntry = {
      ...eligibleEntry,
      value: {
        invocation: {},
        config: {},
        steps: { review: { summary: "Tudo certo" } },
        workspace: {},
      },
    }
    const state = controls({
      entries: [editableEntry],
      onEdit: vi.fn(async () => {
        throw new Error("O output não corresponde ao schema atual")
      }),
    })
    render(<MemoryRouter><WorkflowTestDataBar controls={state} /></MemoryRouter>)

    fireEvent.click(screen.getByRole("button", { name: "Editar JSON" }))
    const editor = screen.getByRole("textbox", { name: "JSON do output fixado review-output" })
    fireEvent.change(editor, { target: { value: '{"summary":"preservar"}' } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar output de teste" }))

    expect((await screen.findByRole("alert")).textContent).toContain(
      "O output não corresponde ao schema atual",
    )
    expect((screen.getByRole("textbox", {
      name: "JSON do output fixado review-output",
    }) as HTMLTextAreaElement).value).toBe('{"summary":"preservar"}')
  })

  it("summarizes multiple active cutpoints and clears them atomically", () => {
    const contextEntry: WorkflowTestDataEntry = {
      ...eligibleEntry,
      name: "context-output",
      eligibility: { kind: "eligible", nodeId: "context" },
      source: { ...eligibleEntry.source!, node_id: "context", run_id: "run-3" },
    }
    const state = controls({
      entries: [eligibleEntry, contextEntry],
      activeFixtureNames: new Set(["review-output", "context-output"]),
    })
    render(<MemoryRouter><WorkflowTestDataBar controls={state} /></MemoryRouter>)

    expect(screen.getByText("2 nodes substituídos")).toBeTruthy()
    expect(screen.getByText("review · context")).toBeTruthy()
    fireEvent.click(screen.getByText("Limpar tudo"))
    expect(state.onClearAll).toHaveBeenCalledOnce()
  })
})
