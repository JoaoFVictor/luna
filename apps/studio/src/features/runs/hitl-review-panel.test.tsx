import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import { StudioApiError } from "@/api/client-core"
import type { RunInterrupt } from "@/api/types"
import { SessionContext } from "@/app/studio-context"
import { HitlReviewPanel } from "@/features/runs/hitl-review-panel"

const RUN_ID = "run-hitl-review"

beforeAll(() => {
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent })
})

function interrupt(overrides: Partial<RunInterrupt> = {}): RunInterrupt {
  return {
    interrupt_id: "interrupt-review-1",
    checkpoint_id: "checkpoint-review-1",
    node_id: "human_review",
    kind: "human_gate",
    status: "pending",
    prompt: "Revise o texto e a imagem antes de publicar.",
    decisions: [{ action: "approve" }, { action: "reject" }],
    review: {
      targets: [{ id: "text", label: "Texto" }, { id: "image", label: "Imagem" }],
      expected_artifact_count: 0,
    },
    materials_status: "ready",
    artifacts: [],
    created_at: "2026-07-12T12:00:00.000Z",
    updated_at: "2026-07-12T12:00:00.000Z",
    ...overrides,
  }
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        <SessionContext.Provider value={{ bootstrap: { mode: "full" }, canMutate: true }}>
          {children}
        </SessionContext.Provider>
      </QueryClientProvider>
    )
  }
}

afterEach(() => vi.restoreAllMocks())

describe("HitlReviewPanel", () => {
  it("shows a preparation diagnostic and blocks only approval", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(studioApi, "runInterrupts").mockResolvedValue({
      run_id: RUN_ID,
      items: [interrupt({
        prompt: "O texto excede o limite ponderado do X.",
        review: {
          targets: [{ id: "text", label: "Texto" }, { id: "image", label: "Imagem" }],
          expected_artifact_count: 0,
          approval: {
            allowed: false,
            reason: "O texto excede o limite ponderado do X. Solicite uma versão mais curta.",
          },
        },
      })],
      next_cursor: null,
    })

    render(<HitlReviewPanel runId={RUN_ID} active />, { wrapper: wrapper(queryClient) })

    expect(await screen.findByText("Esta versão ainda não pode ser aprovada")).toBeDefined()
    expect(screen.getByText(/Solicite uma versão mais curta/)).toBeDefined()
    expect(screen.getByText(/Solicite as alterações necessárias ou rejeite/)).toBeDefined()
    expect(screen.queryByText(/alteração da imagem/)).toBeNull()
    expect(screen.getByRole("button", { name: "Aprovar" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: "Rejeitar e encerrar" }).hasAttribute("disabled")).toBe(false)
  })

  it("shows an actionable error and retries loading the review", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const runInterrupts = vi.spyOn(studioApi, "runInterrupts")
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue({
        run_id: RUN_ID,
        items: [interrupt()],
        next_cursor: null,
      })

    render(<HitlReviewPanel runId={RUN_ID} active />, {
      wrapper: wrapper(queryClient),
    })

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Não foi possível carregar a revisão humana",
    )
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }))

    expect(await screen.findByText("Revisão humana")).toBeDefined()
    expect(runInterrupts).toHaveBeenCalledTimes(2)
  })

  it("sends a generic rejection with optional human feedback", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(studioApi, "runInterrupts").mockResolvedValue({
      run_id: RUN_ID,
      items: [interrupt()],
      next_cursor: null,
    })
    const resume = vi.spyOn(studioApi, "resumeRunInterrupt").mockResolvedValue({
      accepted: true,
      run_id: RUN_ID,
      interrupt_id: "interrupt-review-1",
      resume_status: "resuming",
      already_resumed: false,
    })

    render(<HitlReviewPanel runId={RUN_ID} active />, {
      wrapper: wrapper(queryClient),
    })

    expect(await screen.findByText("Revisão humana")).toBeDefined()
    fireEvent.change(screen.getByLabelText("Mensagem"), {
      target: { value: "O conteúdo ainda não está pronto." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Rejeitar e encerrar" }))

    await waitFor(() => expect(resume).toHaveBeenCalledWith(
      RUN_ID,
      "interrupt-review-1",
      {
        action: "reject",
        comment: "O conteúdo ainda não está pronto.",
      },
    ))
  })

  it("presents a terminal rejection even while its interrupt projection catches up", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(studioApi, "runInterrupts").mockResolvedValue({
      run_id: RUN_ID,
      items: [interrupt({
        status: "resuming",
        decision: { action: "reject", comment: "Encerrar esta publicação." },
      })],
      next_cursor: null,
    })

    render(<HitlReviewPanel runId={RUN_ID} active={false} />, {
      wrapper: wrapper(queryClient),
    })

    expect(await screen.findByText("Rejeitado")).toBeDefined()
    expect(screen.queryByText("Aplicando decisão")).toBeNull()
    expect(screen.queryByText("Agent trabalhando na próxima etapa")).toBeNull()
    expect(screen.queryByText("Decisão pendente")).toBeNull()
    expect(screen.queryByRole("button", { name: "Rejeitar e encerrar" })).toBeNull()
    expect(screen.getByText("Encerrar esta publicação.")).toBeDefined()
  })

  it("uses the canonical id tie-breaker when reviews have the same timestamp", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(studioApi, "runInterrupts").mockResolvedValue({
      run_id: RUN_ID,
      items: [
        interrupt({
          interrupt_id: "interrupt-review-2",
          checkpoint_id: "checkpoint-review-2",
        }),
        interrupt({
          status: "resuming",
          decision: { action: "request_changes", targets: ["text"], comment: "Mais curto." },
        }),
      ],
      next_cursor: null,
    })

    render(<HitlReviewPanel runId={RUN_ID} active />, { wrapper: wrapper(queryClient) })

    expect(await screen.findByRole("button", { name: "Aprovar" })).toBeDefined()
    expect(screen.queryByText("Agent trabalhando na próxima etapa")).toBeNull()
  })

  it("shows prior decisions and keeps the next generic approval actionable", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(studioApi, "runInterrupts").mockResolvedValue({
      run_id: RUN_ID,
      items: [
        interrupt({
          status: "resolved",
          decision: { action: "request_changes", targets: ["image"], comment: "Troque o fundo por azul." },
        }),
        interrupt({
          interrupt_id: "interrupt-review-2",
          checkpoint_id: "checkpoint-review-2",
          created_at: "2026-07-12T12:02:00.000Z",
          updated_at: "2026-07-12T12:02:00.000Z",
          prompt: "Nova versão pronta após os ajustes solicitados.",
        }),
      ],
      next_cursor: null,
    })

    render(<HitlReviewPanel runId={RUN_ID} active />, { wrapper: wrapper(queryClient) })

    expect(await screen.findByText("Alterações solicitadas")).toBeDefined()
    expect(screen.getByText("Troque o fundo por azul.")).toBeDefined()
    expect(screen.getAllByText("Imagem").length).toBeGreaterThan(0)
    expect(screen.getByText("Nova versão pronta após os ajustes solicitados.")).toBeDefined()
    expect(screen.getByRole("button", { name: "Aprovar" })).toBeDefined()
  })

  it("accumulates older cursor pages without losing the current review", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const runInterrupts = vi.spyOn(studioApi, "runInterrupts").mockImplementation(async (_runId, cursor) =>
      cursor === undefined
        ? {
            run_id: RUN_ID,
            items: [interrupt({
              interrupt_id: "interrupt-current",
              checkpoint_id: "checkpoint-current",
              created_at: "2026-07-12T12:02:00.000Z",
              updated_at: "2026-07-12T12:02:00.000Z",
              prompt: "Versão atual",
            })],
            next_cursor: "older-page",
          }
        : {
            run_id: RUN_ID,
            items: [interrupt({
              interrupt_id: "interrupt-older",
              checkpoint_id: "checkpoint-older",
              status: "resolved",
              created_at: "2026-07-12T12:00:00.000Z",
              updated_at: "2026-07-12T12:00:00.000Z",
              prompt: "Versão anterior",
              decision: { action: "request_changes", comment: "Ajuste", targets: ["text"] },
            })],
            next_cursor: null,
          })

    render(<HitlReviewPanel runId={RUN_ID} active />, { wrapper: wrapper(queryClient) })

    expect(await screen.findByText("Versão atual")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Carregar revisões anteriores" }))
    expect(await screen.findByText("Versão anterior")).toBeDefined()
    expect(screen.getByText("Versão atual")).toBeDefined()
    expect(runInterrupts).toHaveBeenLastCalledWith(RUN_ID, "older-page", expect.any(AbortSignal))
  })

  it("keeps the exact artifacts and previews attached to every history entry", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const firstHandle = `ah_${"a".repeat(43)}`
    const secondHandle = `ah_${"b".repeat(43)}`
    const artifact = (handle: string, name: string) => ({
      manifest_handle: handle,
      name,
      source_node_id: "review_loop",
      attempt: 1,
      media_type: "text/plain",
      status: "committed" as const,
      created_at: "2026-07-12T12:00:00.000Z",
      preview_capability: "probe_required" as const,
    })
    const firstArtifact = artifact(firstHandle, "revision-1.txt")
    const secondArtifact = artifact(secondHandle, "revision-2.txt")
    vi.spyOn(studioApi, "runInterrupts").mockResolvedValue({
      run_id: RUN_ID,
      items: [
        interrupt({
          status: "resolved",
          decision: { action: "request_changes", targets: ["text"], comment: "Mais direto." },
          review: { targets: [{ id: "text", label: "Texto" }], expected_artifact_count: 1 },
          artifacts: [firstArtifact],
        }),
        interrupt({
          interrupt_id: "interrupt-review-2",
          checkpoint_id: "checkpoint-review-2",
          created_at: "2026-07-12T12:02:00.000Z",
          updated_at: "2026-07-12T12:02:00.000Z",
          review: { targets: [{ id: "text", label: "Texto" }], expected_artifact_count: 1 },
          artifacts: [secondArtifact],
        }),
      ],
      next_cursor: null,
    })
    vi.spyOn(studioApi, "artifactPreview").mockImplementation(async (_runId, handle) => {
      const selected = handle === firstHandle ? firstArtifact : secondArtifact
      return {
        kind: "text",
        metadata: {
          ...selected,
          content_length: 10,
          downloadable: true,
          raw_download_redaction: "not_applied",
        },
        inspected_bytes: 10,
        truncated: false,
        integrity: "verified",
        encoding: "utf-8",
        text: handle === firstHandle ? "Primeira versão" : "Segunda versão",
        redaction: { mode: "best_effort", changed: false },
        render_policy: "plain_text_only",
      }
    })

    render(<HitlReviewPanel runId={RUN_ID} active />, { wrapper: wrapper(queryClient) })

    expect(await screen.findByText("revision-1.txt")).toBeDefined()
    expect(screen.getByText("revision-2.txt")).toBeDefined()
    expect(await screen.findByText("Primeira versão")).toBeDefined()
    expect(screen.getByText("Segunda versão")).toBeDefined()
  })

  it("keeps every decision disabled while the exact review materials are pending", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(studioApi, "runInterrupts").mockResolvedValue({
      run_id: RUN_ID,
      items: [interrupt({
        materials_status: "pending",
        review: {
          targets: [{ id: "text", label: "Texto" }],
          expected_artifact_count: 2,
        },
      })],
      next_cursor: null,
    })
    const resume = vi.spyOn(studioApi, "resumeRunInterrupt")

    render(<HitlReviewPanel runId={RUN_ID} active />, { wrapper: wrapper(queryClient) })

    expect(await screen.findByText("Materiais da revisão ainda não disponíveis")).toBeDefined()
    expect(screen.getByText(/0 de 2 artefatos esperados/)).toBeDefined()
    expect(screen.getByRole("button", { name: "Aprovar" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: "Rejeitar e encerrar" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: "Solicitar alterações" }).hasAttribute("disabled")).toBe(true)
    expect(resume).not.toHaveBeenCalled()
  })

  it("requires feedback and a declared target before requesting changes", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(studioApi, "runInterrupts").mockResolvedValue({
      run_id: RUN_ID,
      items: [interrupt()],
      next_cursor: null,
    })
    const resume = vi.spyOn(studioApi, "resumeRunInterrupt").mockResolvedValue({
      accepted: true,
      run_id: RUN_ID,
      interrupt_id: "interrupt-review-1",
      resume_status: "waiting_for_input",
      already_resumed: false,
    })

    render(<HitlReviewPanel runId={RUN_ID} active />, { wrapper: wrapper(queryClient) })

    const requestChanges = await screen.findByRole("button", { name: "Solicitar alterações" })
    expect(requestChanges.hasAttribute("disabled")).toBe(true)
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "Use uma composição mais limpa." } })
    expect(requestChanges.hasAttribute("disabled")).toBe(true)
    fireEvent.keyDown(screen.getByRole("checkbox", { name: "Imagem" }), { key: " ", code: "Space" })
    fireEvent.keyUp(screen.getByRole("checkbox", { name: "Imagem" }), { key: " ", code: "Space" })
    expect(requestChanges.hasAttribute("disabled")).toBe(false)
    fireEvent.click(requestChanges)

    await waitFor(() => expect(resume).toHaveBeenCalledWith(RUN_ID, "interrupt-review-1", {
      action: "request_changes",
      comment: "Use uma composição mais limpa.",
      targets: ["image"],
    }))
  })

  it("keeps a catalog-drift resume failure visible with safe next steps", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(studioApi, "runInterrupts").mockResolvedValue({
      run_id: RUN_ID,
      items: [interrupt()],
      next_cursor: null,
    })
    vi.spyOn(studioApi, "resumeRunInterrupt").mockRejectedValue(new StudioApiError({
      status: 409,
      code: "studio_run_resume_catalog_changed",
      message: "The run cannot be resumed because the runtime capability catalog changed",
    }))

    render(<HitlReviewPanel runId={RUN_ID} active />, { wrapper: wrapper(queryClient) })

    fireEvent.click(await screen.findByRole("button", { name: "Aprovar" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("A execução usa outra versão do runtime")
    expect(alert.textContent).toContain("inicie uma nova execução")
    expect(alert.textContent).toContain("studio_run_resume_catalog_changed")
  })
})
