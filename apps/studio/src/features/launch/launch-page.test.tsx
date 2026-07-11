import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

import { StudioApiError, studioApi } from "@/api/client"
import type { RunPlan, RunPlanInput } from "@/api/types"
import { SessionContext } from "@/app/studio-context"
import { LaunchPage } from "@/pages/launch-page"

const planId = `rp_${"p".repeat(32)}`
const digest = (character: string) => `sha256:${character.repeat(64)}`

const plan: RunPlan = {
  plan_id: planId,
  created_at: "2026-07-11T12:00:00.000Z",
  expires_at: "2099-07-11T12:05:00.000Z",
  workflow_id: "review",
  execution_scope: { kind: "workflow" },
  mode: "read_only",
  workflow_revision: digest("1"),
  definition_bundle_hash: digest("2"),
  catalog_fingerprint: digest("3"),
  execution_snapshot_hash: digest("4"),
  invocation_hash: digest("5"),
  config_hash: digest("6"),
  repository_required: false,
  input_provenance: {
    kind: "adapter",
    adapter_id: "task-url",
    adapter_input_hash: digest("7"),
  },
  potential_effects: [],
  resolved_effects: [],
  effect_uncertainties: [],
  warnings: [],
  confirmation_required: false,
  confirmation_token: "t".repeat(48),
}

function wrapper(queryClient: QueryClient, initialEntry: string) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        <SessionContext.Provider
          value={{ bootstrap: { mode: "full" }, canMutate: true }}
        >
          <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>
    )
  }
}

function renderLaunch(
  initialEntry = "/launch",
  executionScope?: RunPlanInput["execution_scope"],
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  render(
    <Routes>
      <Route path="/launch" element={<LaunchPage executionScope={executionScope} />} />
      <Route path="/runs/:runId" element={<p>run-detail-destination</p>} />
    </Routes>,
    { wrapper: wrapper(queryClient, initialEntry) },
  )
}

async function prepareAdapterPlan() {
  const input = await screen.findByLabelText("URL ou identificador")
  fireEvent.change(input, { target: { value: "opaque://task/42" } })
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }))
  expect(await screen.findByText("Antes de executar")).toBeDefined()
}

function confirmRealRun() {
  fireEvent.click(screen.getByLabelText(/Revisei a entrada e os efeitos/))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("LaunchPage", () => {
  it("sends the selected node as an authoritative partial execution scope", async () => {
    vi.spyOn(studioApi, "inputAdapters").mockResolvedValue({
      adapters: [{
        id: "task-url",
        description: "Task URL adapter",
        source: "task",
        input_contract: { kind: "cli", value_type: "string" },
        preview: { enabled: true, effects: [], timeout_ms: 60_000 },
      }],
    })
    const planRun = vi.spyOn(studioApi, "planRun").mockResolvedValue({
      ...plan,
      execution_scope: { kind: "through_node", node_id: "analyze" },
    })
    renderLaunch("/launch", { kind: "through_node", node_id: "analyze" })

    expect(await screen.findByText("Teste parcial até analyze")).toBeDefined()
    await prepareAdapterPlan()
    expect(planRun).toHaveBeenCalledWith(expect.objectContaining({
      execution_scope: { kind: "through_node", node_id: "analyze" },
    }), expect.any(AbortSignal))
  })

  it("plans with the safe adapter union and invalidates the plan when input changes", async () => {
    vi.spyOn(studioApi, "inputAdapters").mockResolvedValue({
      adapters: [{
        id: "task-url",
        description: "Task URL adapter",
        source: "task",
        input_contract: { kind: "cli", value_type: "string" },
        preview: { enabled: true, effects: [], timeout_ms: 60_000 },
      }],
    })
    const planRun = vi.spyOn(studioApi, "planRun").mockResolvedValue(plan)
    renderLaunch("/launch?workflow=browser-forged")

    await prepareAdapterPlan()
    expect(document.body.textContent).not.toContain(plan.confirmation_token)
    expect(planRun).toHaveBeenCalledWith({
      kind: "adapter",
      execution_scope: { kind: "workflow" },
      adapter_id: "task-url",
      input: { kind: "cli", value: "opaque://task/42" },
      acknowledged_effects: [],
    }, expect.any(AbortSignal))
    expect(screen.getByText("read_only")).toBeDefined()
    expect(
      screen.getByText("Esta entrada foi direcionada para outro workflow"),
    ).toBeDefined()

    fireEvent.change(screen.getByLabelText("URL ou identificador"), {
      target: { value: "opaque://task/changed" },
    })
    await waitFor(() => {
      expect(screen.queryByText("Antes de executar")).toBeNull()
    })
  })

  it("requires a new plan after the one-shot confirmation is rejected", async () => {
    vi.spyOn(studioApi, "inputAdapters").mockResolvedValue({
      adapters: [{
        id: "task-url",
        description: "Task URL adapter",
        source: "task",
        input_contract: { kind: "cli", value_type: "string" },
        preview: { enabled: true, effects: [], timeout_ms: 60_000 },
      }],
    })
    vi.spyOn(studioApi, "planRun").mockResolvedValue(plan)
    const execute = vi.spyOn(studioApi, "executeRun").mockRejectedValue(
      new StudioApiError({
        status: 409,
        code: "studio_run_confirmation_invalid",
        message: "Run confirmation is invalid, expired, or already used",
      }),
    )
    renderLaunch()

    await prepareAdapterPlan()
    confirmRealRun()
    fireEvent.click(screen.getByRole("button", { name: "Executar workflow" }))
    expect(await screen.findByText("Crie um novo plano")).toBeDefined()
    expect(screen.queryByText("Antes de executar")).toBeNull()
    expect(screen.queryByRole("button", { name: "Executar workflow" })).toBeNull()
    expect(execute).toHaveBeenCalledOnce()
  })

  it("treats unknown acceptance as indeterminate and navigates only after a 202 receipt", async () => {
    vi.spyOn(studioApi, "inputAdapters").mockResolvedValue({
      adapters: [{
        id: "task-url",
        description: "Task URL adapter",
        source: "task",
        input_contract: { kind: "cli", value_type: "string" },
        preview: { enabled: true, effects: [], timeout_ms: 60_000 },
      }],
    })
    vi.spyOn(studioApi, "planRun").mockResolvedValue(plan)
    const execute = vi.spyOn(studioApi, "executeRun")
      .mockRejectedValueOnce(new StudioApiError({
        status: 503,
        code: "studio_run_dispatch_failed",
        message: "Run acceptance could not be verified",
        details: { acceptance_unknown: true, plan_id: planId },
      }))
      .mockResolvedValueOnce({
        accepted: true,
        dispatch_status: "queued",
        run_id: "queued-run-1",
        plan_id: planId,
        execution_snapshot_hash: digest("4"),
        accepted_at: "2026-07-11T12:00:01.000Z",
      })
    renderLaunch()

    await prepareAdapterPlan()
    confirmRealRun()
    fireEvent.click(screen.getByRole("button", { name: "Executar workflow" }))
    expect(await screen.findByText("Aceite da execução é desconhecido")).toBeDefined()
    expect(
      (screen.getByRole("button", { name: "Executar workflow" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      screen.getByRole("link", { name: /Consultar Runs/ }).getAttribute("href"),
    ).toBe(`/runs?plan_id=${planId}`)
    expect(screen.getAllByText(planId).length).toBeGreaterThan(1)
    fireEvent.click(screen.getByRole("button", { name: "Executar workflow" }))
    expect(execute).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("run-detail-destination")).toBeNull()

    fireEvent.change(screen.getByLabelText("URL ou identificador"), {
      target: { value: "opaque://task/replanned" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }))
    await screen.findByText("Antes de executar")
    confirmRealRun()
    fireEvent.click(screen.getByRole("button", { name: "Executar workflow" }))
    expect(await screen.findByText("run-detail-destination")).toBeDefined()
  })

  it("requires every declared adapter load effect before planning", async () => {
    vi.spyOn(studioApi, "inputAdapters").mockResolvedValue({
      adapters: [{
        id: "task-url",
        description: "Task URL adapter",
        source: "task",
        input_contract: { kind: "cli", value_type: "string" },
        preview: {
          enabled: true,
          effects: ["credential_read", "network_read"],
          timeout_ms: 60_000,
        },
      }],
    })
    const planRun = vi.spyOn(studioApi, "planRun").mockResolvedValue(plan)
    renderLaunch()

    fireEvent.change(await screen.findByLabelText("URL ou identificador"), {
      target: { value: "opaque://task/42" },
    })
    const planButton = screen.getByRole("button", {
      name: "Continuar",
    }) as HTMLButtonElement
    expect(planButton.disabled).toBe(true)

    fireEvent.click(screen.getByLabelText("Usará a conexão configurada"))
    expect(planButton.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText("Consultará dados externos"))
    expect(planButton.disabled).toBe(false)
    fireEvent.click(planButton)

    await waitFor(() => expect(planRun).toHaveBeenCalledWith({
      kind: "adapter",
      execution_scope: { kind: "workflow" },
      adapter_id: "task-url",
      input: { kind: "cli", value: "opaque://task/42" },
      acknowledged_effects: ["credential_read", "network_read"],
    }, expect.any(AbortSignal)))
  })
})
