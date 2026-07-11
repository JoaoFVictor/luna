import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import { SessionContext } from "@/app/studio-context"
import { WorkflowsPage } from "@/pages/workflows-page"

const DIGEST = `sha256:${"a".repeat(64)}`

function wrapper(initialEntry = "/workflows", canMutate = true) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        <SessionContext.Provider
          value={{
            bootstrap: { mode: canMutate ? "full" : "read-only-session" },
            canMutate,
          }}
        >
          <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>
    )
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("WorkflowsPage", () => {
  it("shows loader diagnostics when every workflow is invalid", async () => {
    vi.spyOn(studioApi, "workflows").mockResolvedValue({
      status: "partial",
      fingerprint: DIGEST,
      workflows: [],
      diagnostics: [{
        severity: "error",
        code: "workflow_definition_invalid",
        message: "Workflow broken could not be loaded.",
        resource_kind: "workflow",
        resource_id: "broken",
      }],
    })
    vi.spyOn(studioApi, "drafts").mockResolvedValue({
      items: [],
      diagnostics: [],
      next_cursor: null,
    })
    vi.spyOn(studioApi, "draftTemplates").mockResolvedValue({
      templates: [],
    })
    vi.spyOn(studioApi, "agents").mockResolvedValue({
      status: "complete",
      fingerprint: DIGEST,
      agents: [],
      diagnostics: [],
    })

    render(<WorkflowsPage />, { wrapper: wrapper() })

    expect(await screen.findByText(
      "Catálogo parcial: 1 workflow(s) inválido(s)",
    )).toBeTruthy()
    expect(screen.getByText(/broken: workflow_definition_invalid/u)).toBeTruthy()
    expect(screen.getByText("Nenhum workflow válido carregado")).toBeTruthy()
    expect(screen.getByText(
      "Todos os candidatos podem ter sido rejeitados; revise os diagnósticos do catálogo acima.",
    )).toBeTruthy()
  })

  it("does not open or submit the creation deep-link in a read-only session", async () => {
    vi.spyOn(studioApi, "workflows").mockResolvedValue({
      status: "complete",
      fingerprint: DIGEST,
      workflows: [],
      diagnostics: [],
    })
    vi.spyOn(studioApi, "drafts").mockResolvedValue({
      items: [],
      diagnostics: [],
      next_cursor: null,
    })
    vi.spyOn(studioApi, "draftTemplates").mockResolvedValue({
      templates: [],
    })
    vi.spyOn(studioApi, "agents").mockResolvedValue({
      status: "complete",
      fingerprint: DIGEST,
      agents: [],
      diagnostics: [],
    })
    const create = vi.spyOn(studioApi, "createDraft")

    render(<WorkflowsPage />, {
      wrapper: wrapper("/workflows?new=1", false),
    })

    expect(await screen.findByText("Nenhum workflow válido carregado"))
      .toBeTruthy()
    expect(screen.queryByLabelText("ID do workflow")).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })
})
