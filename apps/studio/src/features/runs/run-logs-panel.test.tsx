import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import { RunLogsPanel } from "@/features/runs/run-logs-panel"

const RUN_ID = "run-log-test"

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

function logPage() {
  return {
    run_id: RUN_ID,
    next_cursor: null,
    as_of: "2026-07-12T12:00:00.000Z",
    snapshot_bytes: 512,
    scanned_bytes: 512,
    redaction: "best_effort" as const,
    items: [
      {
        sequence: 1,
        timestamp: "2026-07-12T11:59:00.000Z",
        level: "info" as const,
        node_id: "prepare",
        message: "started",
        redaction: "best_effort" as const,
      },
      {
        sequence: 2,
        timestamp: "2026-07-12T11:59:01.000Z",
        level: "debug" as const,
        node_id: "prepare",
        message: "heartbeat",
        redaction: "best_effort" as const,
      },
      {
        sequence: 3,
        timestamp: "2026-07-12T11:59:02.000Z",
        level: "error" as const,
        node_id: "publish",
        message: "request failed",
        redaction: "best_effort" as const,
      },
    ],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

if (typeof window !== "undefined" && typeof window.PointerEvent !== "function") {
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: MouseEvent,
  })
}

describe("RunLogsPanel", () => {
  it("hides technical heartbeat entries and supports node/search filters", async () => {
    const runLogs = vi.spyOn(studioApi, "runLogs").mockResolvedValue(logPage())
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<RunLogsPanel runId={RUN_ID} />, { wrapper: wrapper(queryClient) })

    expect(await screen.findByText("request failed")).toBeDefined()
    expect(screen.queryByText("heartbeat")).toBeNull()

    fireEvent.change(screen.getByLabelText("Buscar em mensagens e nodes"), {
      target: { value: "request" },
    })
    expect(screen.getByText("request failed")).toBeDefined()
    expect(screen.getByText("started")).toBeDefined()

    fireEvent.change(screen.getAllByLabelText("Filtrar logs por node")[0]!, {
      target: { value: "prepare" },
    })
    await waitFor(() => expect(runLogs).toHaveBeenLastCalledWith(
      RUN_ID,
      expect.objectContaining({ nodeId: "prepare" }),
      expect.anything(),
    ))
    queryClient.clear()
  })

  it("copies a provider-neutral diagnostic and can reveal technical events", async () => {
    vi.spyOn(studioApi, "runLogs").mockResolvedValue(logPage())
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<RunLogsPanel runId={RUN_ID} />, { wrapper: wrapper(queryClient) })
    await screen.findByText("request failed")

    fireEvent.click(screen.getByRole("button", { name: /Copiar diagnóstico/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(writeText.mock.calls[0]?.[0]).toContain(`execução ${RUN_ID}`)
    expect(writeText.mock.calls[0]?.[0]).toContain("request failed")
    expect(writeText.mock.calls[0]?.[0]).not.toContain("heartbeat")

    fireEvent.click(screen.getByRole("switch", { name: "Mostrar eventos técnicos" }))
    await waitFor(() => expect(screen.getByText("heartbeat")).toBeDefined())
    queryClient.clear()
  })
})
