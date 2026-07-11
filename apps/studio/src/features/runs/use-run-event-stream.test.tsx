import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioKeys } from "@/api/queries"
import { useRunEventStream } from "@/features/runs/use-run-event-stream"

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = []

  readonly url: string
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn(() => {
    this.readyState = 2
  })

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  open() {
    this.readyState = 1
    this.onopen?.(new Event("open"))
  }

  fail() {
    this.onerror?.(new Event("error"))
  }

  emit(name: string, data: unknown) {
    this.dispatchEvent(
      new MessageEvent(name, {
        data: typeof data === "string" ? data : JSON.stringify(data),
      }),
    )
  }
}

function queryWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    )
  }
}

function runEvent(sequence: number) {
  return {
    schema_version: 1,
    run_id: "run:one",
    sequence,
    event_id: `event-${sequence}`,
    event_type: "node.started",
    occurred_at: "2026-07-10T12:00:00.000Z",
    data: { node_id: "node-a" },
  }
}

afterEach(() => {
  FakeEventSource.instances = []
  vi.unstubAllGlobals()
})

describe("useRunEventStream", () => {
  it("resumes after the initial snapshot and refreshes canonical run queries", async () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const queryClient = new QueryClient()
    const invalidations = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(
      () =>
        useRunEventStream({
          runId: "run:one",
          afterSequence: 4,
          enabled: true,
        }),
      { wrapper: queryWrapper(queryClient) },
    )

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const source = FakeEventSource.instances[0]
    expect(source.url).toBe(
      "/api/studio/v1/runs/run%3Aone/events/stream?after_sequence=4",
    )
    act(() => source.open())
    expect(result.current).toBe("live")

    act(() => {
      source.emit("run-event", runEvent(5))
      source.emit("stream-complete", {
        run_id: "run:one",
        status: "succeeded",
      })
    })

    expect(result.current).toBe("complete")
    expect(source.close).toHaveBeenCalledOnce()
    expect(invalidations).toHaveBeenCalledWith({
      queryKey: studioKeys.run("run:one"),
      exact: true,
    })
    expect(invalidations).toHaveBeenCalledWith({
      queryKey: studioKeys.timeline("run:one"),
      exact: true,
    })
    expect(invalidations).toHaveBeenCalledWith({ queryKey: studioKeys.runs })
  })

  it("closes a stream with a gap or payload outside the canonical contract", async () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const queryClient = new QueryClient()
    const { result } = renderHook(
      () =>
        useRunEventStream({
          runId: "run:one",
          afterSequence: 4,
          enabled: true,
        }),
      { wrapper: queryWrapper(queryClient) },
    )

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const source = FakeEventSource.instances[0]
    act(() => source.emit("run-event", runEvent(6)))

    expect(result.current).toBe("invalid")
    expect(source.close).toHaveBeenCalledOnce()
  })

  it("reports browser reconnection while preserving polling fallback", async () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const queryClient = new QueryClient()
    const { result } = renderHook(
      () =>
        useRunEventStream({
          runId: "run:one",
          afterSequence: 4,
          enabled: true,
        }),
      { wrapper: queryWrapper(queryClient) },
    )

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => FakeEventSource.instances[0].fail())
    expect(result.current).toBe("reconnecting")
  })
})
