import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import type { ProviderConfiguration } from "@/api/types"
import { ProviderConnectionCard } from "@/features/configuration/provider-connection-card"

type Provider = ProviderConfiguration["providers"][number]

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

const planeProvider: Provider = {
  id: "plane",
  adapter_ids: ["plane-task-url"],
  credential_status: "not_checked",
  probe: {
    id: "plane",
    effects: ["credential_read", "network_read"],
    timeout_ms: 10_000,
  },
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ProviderConnectionCard", () => {
  it("runs the provider probe directly and presents a healthy result", async () => {
    const testConnection = vi.spyOn(studioApi, "testProviderConnection").mockResolvedValue({
      provider_id: "plane",
      probe_id: "plane",
      status: "healthy",
      checked_at: "2026-07-12T03:00:00.000Z",
      effects: ["credential_read", "network_read"],
      timeout_ms: 10_000,
      summary: "Plane respondeu para a instância configurada.",
    })

    render(<ProviderConnectionCard provider={planeProvider} adapters={[]} />, {
      wrapper: wrapper(),
    })

    expect(screen.getByText("Lê credencial local")).toBeTruthy()
    expect(screen.getByText("Consulta somente leitura")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }))

    await waitFor(() => {
      expect(testConnection).toHaveBeenCalledWith("plane")
    })
    expect(await screen.findByText("Conexão confirmada")).toBeTruthy()
    expect(screen.getByText("Plane respondeu para a instância configurada.")).toBeTruthy()
  })

  it("labels a failed probe as a connection failure", async () => {
    vi.spyOn(studioApi, "testProviderConnection").mockResolvedValue({
      provider_id: "plane",
      probe_id: "plane",
      status: "unhealthy",
      effects: ["credential_read", "network_read"],
      timeout_ms: 10_000,
      summary: "Plane não respondeu ao teste de conexão.",
    })

    render(<ProviderConnectionCard provider={planeProvider} adapters={[]} />, {
      wrapper: wrapper(),
    })
    fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }))

    expect(await screen.findByText("Falha na conexão")).toBeTruthy()
    expect(screen.getByText("Plane não respondeu ao teste de conexão.")).toBeTruthy()
  })
})
