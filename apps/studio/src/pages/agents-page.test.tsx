import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import { SessionContext } from "@/app/studio-context"
import { AgentsPage } from "@/pages/agents-page"

const DIGEST = `sha256:${"a".repeat(64)}`

function wrapper(initialEntry = "/agents", canMutate = true) {
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

function mockDrafts() {
  return vi.spyOn(studioApi, "drafts").mockResolvedValue({
    items: [],
    diagnostics: [],
    next_cursor: null,
  })
}

function mockModels(profiles: string[]) {
  return vi.spyOn(studioApi, "modelConfiguration").mockResolvedValue({
    editing: "read_only",
    profiles: profiles.map((id) => ({
      id,
      source: { kind: "literal", model: `model-for-${id}` },
      reasoning_effort: "low",
      transport: "auto",
      consumers: [],
    })),
    diagnostics: profiles.length === 0
      ? [{
          severity: "error",
          code: "configuration_models_unavailable",
          message: "Model profile configuration is unavailable",
        }]
      : [],
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("AgentsPage", () => {
  it("shows partial catalog diagnostics even when every agent is invalid", async () => {
    vi.spyOn(studioApi, "agents").mockResolvedValue({
      status: "partial",
      fingerprint: DIGEST,
      agents: [],
      diagnostics: [{
        severity: "error",
        code: "agent_definition_invalid",
        message: "Agent broken could not be loaded (agent_definition_invalid).",
        resource_kind: "agent",
        resource_id: "broken",
      }],
    })
    mockDrafts()
    mockModels(["fast"])

    render(<AgentsPage />, { wrapper: wrapper() })

    expect(await screen.findByText("Catálogo parcial: 1 agent(s) inválido(s)")).toBeTruthy()
    expect(screen.getByText(/broken: agent_definition_invalid/u)).toBeTruthy()
    expect(screen.getByText("Nenhum agent válido carregado")).toBeTruthy()
  })

  it("requires an explicit real model profile and sends it with blank creation", async () => {
    vi.spyOn(studioApi, "agents").mockResolvedValue({
      status: "complete",
      fingerprint: DIGEST,
      agents: [],
      diagnostics: [],
    })
    mockDrafts()
    mockModels(["deep", "fast"])
    const create = vi.spyOn(studioApi, "createDraft").mockResolvedValue({
      draft_id: "cb937af3-d389-401b-b076-3f41d67c7cc6",
    } as never)

    render(<AgentsPage />, { wrapper: wrapper("/agents?new=1") })

    const id = await screen.findByLabelText("ID do agent")
    const profile = screen.getByLabelText("Model profile")
    const submit = screen.getByRole("button", { name: "Criar draft" })
    expect((submit as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(id, { target: { value: "reviewer" } })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(profile, { target: { value: "deep" } })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(
        {
          resource: { kind: "agent", id: "reviewer" },
          source: { mode: "blank", model_profile: "deep" },
        },
      )
    })
  })

  it("blocks blank creation when no model profile is available", async () => {
    vi.spyOn(studioApi, "agents").mockResolvedValue({
      status: "complete",
      fingerprint: DIGEST,
      agents: [],
      diagnostics: [],
    })
    mockDrafts()
    mockModels([])
    const create = vi.spyOn(studioApi, "createDraft")

    render(<AgentsPage />, { wrapper: wrapper("/agents?new=1") })

    fireEvent.change(await screen.findByLabelText("ID do agent"), {
      target: { value: "reviewer" },
    })
    expect(screen.getByText("Nenhum model profile válido está disponível em config/models.yaml.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Criar draft" }) as HTMLButtonElement).disabled).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it("does not open or submit the creation deep-link in a read-only session", async () => {
    vi.spyOn(studioApi, "agents").mockResolvedValue({
      status: "complete",
      fingerprint: DIGEST,
      agents: [],
      diagnostics: [],
    })
    mockDrafts()
    mockModels(["fast"])
    const create = vi.spyOn(studioApi, "createDraft")

    render(<AgentsPage />, {
      wrapper: wrapper("/agents?new=1", false),
    })

    expect(await screen.findByText("Nenhum agent válido carregado")).toBeTruthy()
    expect(screen.queryByLabelText("ID do agent")).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })
})
