import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import { studioKeys } from "@/api/queries"
import type { ArtifactList, ArtifactPreview, JsonValue } from "@/api/types"
import { ArtifactsPanel } from "@/features/runs/artifacts-panel"
import { STUDIO_ARTIFACT_SEMANTIC_TYPES } from "../../../../../src/studio/contracts/artifact-semantics.js"

const RUN_ID = "run-artifact-test"
const HANDLE = `ah_${"a".repeat(43)}`
const COMMITTED_HANDLE = `ah_${"b".repeat(43)}`

function artifactList(status: "pending" | "committed"): ArtifactList {
  return {
    run_id: RUN_ID,
    items: [
      {
        manifest_handle: HANDLE,
        name: "report.txt",
        attempt: 1,
        media_type: "text/plain",
        status,
        created_at: "2026-07-10T12:00:00.000Z",
        preview_capability:
          status === "pending" ? "unavailable" : "probe_required",
      },
    ],
    redaction: "best_effort_on_preview",
  }
}

function findingsArtifactList(): ArtifactList {
  const list = artifactList("committed")
  const item = list.items[0]
  if (item === undefined) throw new Error("Expected artifact fixture")

  return {
    ...list,
    items: [
      {
        ...item,
        name: "findings.json",
        media_type: "application/json",
        semantic_type: STUDIO_ARTIFACT_SEMANTIC_TYPES.reviewFindings,
      },
    ],
  }
}

function findingsPreview(value: JsonValue): ArtifactPreview {
  const artifact = findingsArtifactList().items[0]
  if (artifact === undefined) throw new Error("Expected artifact fixture")

  return {
    kind: "json",
    metadata: {
      ...artifact,
      content_length: 256,
      downloadable: true,
      raw_download_redaction: "not_applied",
    },
    inspected_bytes: 256,
    truncated: false,
    integrity: "verified",
    encoding: "utf-8",
    value,
    redaction: { mode: "best_effort", changed: false },
    render_policy: "structured_data_only",
  }
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    )
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("ArtifactsPanel", () => {
  it("stops polling a permanently pending artifact after the terminal deadline", async () => {
    vi.useFakeTimers()
    vi.setSystemTime("2026-07-10T12:03:00.000Z")
    const artifacts = vi.spyOn(studioApi, "artifacts")
      .mockResolvedValue(artifactList("pending"))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const view = render(
      <ArtifactsPanel
        runId={RUN_ID}
        expectedCount={1}
        terminalAt="2026-07-10T12:00:00.000Z"
      />,
      { wrapper: wrapper(queryClient) },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText("Artifact ainda está sendo produzido")).toBeDefined()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(artifacts).toHaveBeenCalledOnce()
    view.unmount()
    queryClient.clear()
  })

  it("retries until the terminal record's expected artifact is visible", async () => {
    vi.useFakeTimers()
    const artifacts = vi.spyOn(studioApi, "artifacts")
      .mockResolvedValueOnce({
        run_id: RUN_ID,
        items: [],
        redaction: "best_effort_on_preview",
      })
      .mockResolvedValue(artifactList("committed"))
    vi.spyOn(studioApi, "artifactPreview").mockResolvedValue({
      kind: "text",
      metadata: {
        ...artifactList("committed").items[0],
        content_length: 4,
        downloadable: true,
        raw_download_redaction: "not_applied",
      },
      inspected_bytes: 4,
      truncated: false,
      integrity: "verified",
      encoding: "utf-8",
      text: "safe",
      redaction: { mode: "best_effort", changed: false },
      render_policy: "plain_text_only",
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const view = render(<ArtifactsPanel runId={RUN_ID} expectedCount={1} />, {
      wrapper: wrapper(queryClient),
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText("Nenhum artifact exposto pelo reader.")).toBeDefined()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(screen.getByRole("button", { name: /report\.txt committed/ })).toBeDefined()
    expect(artifacts).toHaveBeenCalledTimes(2)
    view.unmount()
    queryClient.clear()
  })

  it("selects a readable artifact before an unavailable pending manifest", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const pending = artifactList("pending").items[0]
    const committed = artifactList("committed").items[0]
    if (pending === undefined || committed === undefined) {
      throw new Error("Expected artifact fixtures")
    }
    vi.spyOn(studioApi, "artifacts").mockResolvedValue({
      run_id: RUN_ID,
      items: [
        pending,
        {
          ...committed,
          manifest_handle: COMMITTED_HANDLE,
          name: "ready.json",
          media_type: "application/json",
        },
      ],
      redaction: "best_effort_on_preview",
    })
    const preview = vi.spyOn(studioApi, "artifactPreview").mockResolvedValue({
      kind: "json",
      metadata: {
        ...committed,
        manifest_handle: COMMITTED_HANDLE,
        name: "ready.json",
        media_type: "application/json",
        content_length: 15,
        downloadable: true,
        raw_download_redaction: "not_applied",
      },
      inspected_bytes: 15,
      truncated: false,
      integrity: "verified",
      encoding: "utf-8",
      value: { state: "safe" },
      redaction: { mode: "best_effort", changed: false },
      render_policy: "structured_data_only",
    })

    render(<ArtifactsPanel runId={RUN_ID} />, {
      wrapper: wrapper(queryClient),
    })

    expect(await screen.findByText(/safe/)).toBeDefined()
    expect(
      screen.getByRole("button", { name: /ready\.json committed/ })
        .getAttribute("aria-pressed"),
    ).toBe("true")
    expect(preview).toHaveBeenCalledOnce()
  })

  it("does not request an unavailable preview and starts it after the manifest commits", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    vi.spyOn(studioApi, "artifacts").mockResolvedValue(artifactList("pending"))
    const preview = vi.spyOn(studioApi, "artifactPreview").mockResolvedValue({
      kind: "text",
      metadata: {
        ...artifactList("committed").items[0],
        content_length: 4,
        downloadable: true,
        raw_download_redaction: "not_applied",
      },
      inspected_bytes: 4,
      truncated: false,
      integrity: "not_declared",
      encoding: "utf-8",
      text: "safe",
      redaction: { mode: "best_effort", changed: false },
      render_policy: "plain_text_only",
    })

    render(<ArtifactsPanel runId={RUN_ID} />, {
      wrapper: wrapper(queryClient),
    })

    expect(
      await screen.findByText("Artifact ainda está sendo produzido"),
    ).toBeDefined()
    expect(preview).not.toHaveBeenCalled()

    act(() => {
      queryClient.setQueryData(
        studioKeys.artifacts(RUN_ID),
        artifactList("committed"),
      )
    })

    await waitFor(() => expect(preview).toHaveBeenCalledOnce())
    expect(await screen.findByText("safe")).toBeDefined()
  })

  it("renders a known semantic artifact through its validated specialized view", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    vi.spyOn(studioApi, "artifacts").mockResolvedValue(findingsArtifactList())
    vi.spyOn(studioApi, "artifactPreview").mockResolvedValue(
      findingsPreview({
        summary: "Inspecionado em /home/private/repository",
        findings: [
          {
            title: "Validação ausente",
            severity: "high",
            confidence: "high",
            description: "A saída não é validada.",
            evidence: [{ path: "src/a.ts", line_start: 2, line_end: 3 }],
            recommendation: "Adicionar validação.",
            fingerprint: "private-fingerprint",
          },
        ],
      }),
    )

    const view = render(<ArtifactsPanel runId={RUN_ID} />, {
      wrapper: wrapper(queryClient),
    })

    expect(await screen.findByText("Findings da revisão")).toBeDefined()
    expect(screen.getByText("Validação ausente")).toBeDefined()
    expect(view.container.textContent).toContain("[PATH REDACTED]")
    expect(view.container.textContent).not.toContain("/home/private")
    expect(view.container.textContent).not.toContain("private-fingerprint")
  })

  it("uses a path-redacted generic preview when a known payload drifts", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    vi.spyOn(studioApi, "artifacts").mockResolvedValue(findingsArtifactList())
    vi.spyOn(studioApi, "artifactPreview").mockResolvedValue(
      findingsPreview({
        unexpected: "stored at C:/Users/alice/private",
      }),
    )

    const view = render(<ArtifactsPanel runId={RUN_ID} />, {
      wrapper: wrapper(queryClient),
    })

    expect(await screen.findByText(/unexpected/)).toBeDefined()
    expect(view.container.textContent).toContain("[PATH REDACTED]")
    expect(view.container.textContent).not.toContain("C:/Users/alice")
  })

  it("copies only the redacted preview value", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    vi.spyOn(studioApi, "artifacts").mockResolvedValue(artifactList("committed"))
    vi.spyOn(studioApi, "artifactPreview").mockResolvedValue({
      kind: "text",
      metadata: {
        ...artifactList("committed").items[0],
        content_length: 32,
        downloadable: true,
        raw_download_redaction: "not_applied",
      },
      inspected_bytes: 32,
      truncated: false,
      integrity: "verified",
      encoding: "utf-8",
      text: "saved at /home/alice/private/report.txt",
      redaction: { mode: "best_effort", changed: true },
      render_policy: "plain_text_only",
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })

    render(<ArtifactsPanel runId={RUN_ID} />, {
      wrapper: wrapper(queryClient),
    })

    fireEvent.click(await screen.findByRole("button", { name: "Copiar preview seguro" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(writeText.mock.calls[0]?.[0]).toContain("[PATH REDACTED]")
    expect(writeText.mock.calls[0]?.[0]).not.toContain("/home/alice")
  })
})
