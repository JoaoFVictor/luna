import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"

import { SessionContext } from "@/app/studio-context"
import { studioApi } from "@/api/client"
import { RunNodeOutputPanel } from "@/features/runs/run-node-output-panel"

const DIGEST = `sha256:${"a".repeat(64)}`
const DRAFT_ID = "15956bef-49cb-4c8b-acc2-bd189fb9d3b3"
const ETAG = `"studio-draft:${DRAFT_ID}:2:${DIGEST}"`

function wrapper(queryClient: QueryClient, canMutate = true) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <SessionContext.Provider
            value={{
              bootstrap: { mode: canMutate ? "full" : "read-only-session" },
              canMutate,
            }}
          >
            {children}
          </SessionContext.Provider>
        </QueryClientProvider>
      </MemoryRouter>
    )
  }
}

afterEach(() => vi.restoreAllMocks())

describe("RunNodeOutputPanel", () => {
  it("loads the authorized value only after an explicit user action", async () => {
    const load = vi.spyOn(studioApi, "runNodeOutput").mockResolvedValue({
      schema_version: 1,
      availability: "available",
      run: {
        run_id: "run-1",
        workflow_id: "code-review",
        workflow_revision: DIGEST,
        definition_bundle_hash: DIGEST,
        execution_snapshot_hash: DIGEST,
        status: "succeeded",
        completeness: "complete",
      },
      node_id: "review",
      graph_hash: DIGEST,
      outcome_hash: DIGEST,
      output: {
        availability: "available",
        value: { summary: "Review approved", password: "[REDACTED]" },
        redaction: { mode: "best_effort", changed: true },
      },
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(<RunNodeOutputPanel runId="run-1" nodeId="review" />, {
      wrapper: wrapper(queryClient),
    })

    expect(load).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Carregar dados reais" }))
    expect(await screen.findByText(/Review approved/)).toBeDefined()
    expect(screen.getByText("Segredos detectados foram removidos.")).toBeDefined()
    expect(load).toHaveBeenCalledWith("run-1", "review", expect.any(AbortSignal))
  })

  it("explains outputs that exceeded the safe retention limit", async () => {
    vi.spyOn(studioApi, "runNodeOutput").mockResolvedValue({
      schema_version: 1,
      availability: "available",
      run: {
        run_id: "run-1",
        workflow_id: "code-review",
        workflow_revision: DIGEST,
        definition_bundle_hash: DIGEST,
        execution_snapshot_hash: DIGEST,
        status: "succeeded",
        completeness: "complete",
      },
      node_id: "review",
      graph_hash: DIGEST,
      outcome_hash: DIGEST,
      output: {
        availability: "unavailable",
        reason: "value_limit_exceeded",
      },
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(<RunNodeOutputPanel runId="run-1" nodeId="review" />, {
      wrapper: wrapper(queryClient),
    })
    fireEvent.click(screen.getByRole("button", { name: "Carregar dados reais" }))

    expect(await screen.findByText("Output maior que o limite seguro")).toBeDefined()
  })

  it("allows retrying when an active run has not produced a terminal snapshot", async () => {
    const load = vi.spyOn(studioApi, "runNodeOutput").mockResolvedValue({
      schema_version: 1,
      availability: "unavailable",
      run: {
        run_id: "run-1",
        workflow_id: "code-review",
        workflow_revision: DIGEST,
        definition_bundle_hash: DIGEST,
        execution_snapshot_hash: DIGEST,
        status: "running",
        completeness: "complete",
      },
      node_id: "review",
      reason: "run_not_terminal",
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(<RunNodeOutputPanel runId="run-1" nodeId="review" />, {
      wrapper: wrapper(queryClient),
    })
    fireEvent.click(screen.getByRole("button", { name: "Carregar dados reais" }))
    fireEvent.click(await screen.findByRole("button", { name: "Tentar novamente" }))

    expect(load).toHaveBeenCalledTimes(2)
  })

  it("promotes the hash-bound output into its exact source draft", async () => {
    vi.spyOn(studioApi, "runNodeOutput").mockResolvedValue({
      schema_version: 1,
      availability: "available",
      run: {
        run_id: "run-1",
        workflow_id: "code-review",
        workflow_revision: DIGEST,
        definition_bundle_hash: DIGEST,
        execution_snapshot_hash: DIGEST,
        status: "succeeded",
        completeness: "complete",
      },
      node_id: "review",
      graph_hash: DIGEST,
      outcome_hash: DIGEST,
      output: {
        availability: "available",
        value: { summary: "Review approved" },
        redaction: { mode: "best_effort", changed: false },
      },
    })
    const draft = {
      draft_id: DRAFT_ID,
      record_revision: 2,
      content_revision: 1,
      layout_revision: 1,
      primary_resource: { kind: "workflow" as const, id: "code-review" },
      status: "valid" as const,
      draft_hash: DIGEST,
      etag: ETAG,
      files: [],
      layout: {},
      created_at: "2026-07-11T09:00:00.000Z",
      updated_at: "2026-07-11T09:01:00.000Z",
    }
    vi.spyOn(studioApi, "draft").mockResolvedValue(draft)
    const promote = vi
      .spyOn(studioApi, "promoteRunNodeOutputFixture")
      .mockResolvedValue({ ...draft, record_revision: 3, layout_revision: 2 })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })

    render(
      <RunNodeOutputPanel runId="run-1" nodeId="review" draftId={DRAFT_ID} />,
      { wrapper: wrapper(queryClient) },
    )
    fireEvent.click(screen.getByRole("button", { name: "Carregar dados reais" }))
    fireEvent.click(await screen.findByRole("button", { name: "Salvar para preview" }))
    const name = await screen.findByRole("textbox", { name: "Nome dos dados de preview" })
    fireEvent.change(name, { target: { value: "approved-review" } })
    fireEvent.click(await screen.findByRole("button", { name: "Salvar dados para preview" }))

    const editorLink = await screen.findByRole("link", { name: "Abrir “approved-review” no editor" })
    expect(editorLink.getAttribute("href")).toBe(
      `/drafts/${DRAFT_ID}?panel=test-data&test_data=approved-review&fixture=approved-review&node=review`,
    )
    expect(promote).toHaveBeenCalledWith(DRAFT_ID, ETAG, {
      fixture_name: "approved-review",
      run_id: "run-1",
      node_id: "review",
      graph_hash: DIGEST,
      outcome_hash: DIGEST,
    })
  })

  it("does not allow a read-only session to save preview data", async () => {
    vi.spyOn(studioApi, "runNodeOutput").mockResolvedValue({
      schema_version: 1,
      availability: "available",
      run: {
        run_id: "run-1",
        workflow_id: "code-review",
        workflow_revision: DIGEST,
        definition_bundle_hash: DIGEST,
        execution_snapshot_hash: DIGEST,
        status: "succeeded",
        completeness: "complete",
      },
      node_id: "review",
      graph_hash: DIGEST,
      outcome_hash: DIGEST,
      output: {
        availability: "available",
        value: { summary: "Review approved" },
        redaction: { mode: "best_effort", changed: false },
      },
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <RunNodeOutputPanel runId="run-1" nodeId="review" draftId={DRAFT_ID} />,
      { wrapper: wrapper(queryClient, false) },
    )
    fireEvent.click(screen.getByRole("button", { name: "Carregar dados reais" }))

    expect(
      (await screen.findByRole("button", { name: "Salvar para preview" }))
        .getAttribute("disabled"),
    ).not.toBeNull()
  })
})
