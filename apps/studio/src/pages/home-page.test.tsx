import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import { SessionContext } from "@/app/studio-context"
import { HomePage } from "@/pages/home-page"

function readOnlyWrapper({ children }: PropsWithChildren) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider
        value={{
          bootstrap: { mode: "read-only-session" },
          canMutate: false,
        }}
      >
        <MemoryRouter>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  )
}

afterEach(() => vi.restoreAllMocks())

describe("HomePage", () => {
  it("does not advertise creation links in a read-only session", async () => {
    vi.spyOn(studioApi, "workflows").mockResolvedValue({
      status: "complete",
      fingerprint: `sha256:${"a".repeat(64)}`,
      workflows: [],
      diagnostics: [],
    })
    vi.spyOn(studioApi, "drafts").mockResolvedValue({
      items: [],
      diagnostics: [],
      next_cursor: null,
    })
    vi.spyOn(studioApi, "runs").mockResolvedValue({
      items: [],
      next_cursor: null,
    } as never)

    render(<HomePage />, { wrapper: readOnlyWrapper })

    expect(await screen.findByText(
      "Sessão somente leitura: criação e apply indisponíveis.",
    )).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Novo workflow" })).toBeNull()
    expect(screen.queryByRole("link", { name: "Novo agent" })).toBeNull()
  })
})
