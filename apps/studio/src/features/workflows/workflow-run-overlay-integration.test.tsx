import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import type { RunCatalogPage, RunGraphResponse, RunRecord } from "@/api/types"
import { useWorkflowRunOverlay } from "@/features/workflows/use-workflow-run-overlay"
import { WorkflowRunOverlayBar } from "@/features/workflows/workflow-run-overlay-bar"
import { WorkflowDesignView } from "@/features/workflows/workflow-design-view"

vi.mock("@/features/workflows/workflow-graph", () => ({
  WorkflowGraph: ({ execution }: {
    execution?: ReadonlyMap<string, { readonly status?: string }>
  }) => (
    <output aria-label="canvas-execution">
      {execution?.get("review")?.status ?? "none"}
    </output>
  ),
}))

const REVISION = `sha256:${"a".repeat(64)}`
const OTHER_REVISION = `sha256:${"b".repeat(64)}`

function catalogItem(runId: string, status: "succeeded" | "failed" = "succeeded") {
  return {
    run_id: runId,
    workflow_id: "review",
    workflow_revision: REVISION,
    execution_snapshot_hash: REVISION,
    dispatch_status: "started" as const,
    run_status: status,
    status,
    created_at: runId === "run-two"
      ? "2026-07-11T13:00:00.000Z"
      : "2026-07-11T12:00:00.000Z",
    started_at: "2026-07-11T12:00:01.000Z",
    finished_at: "2026-07-11T12:00:03.000Z",
    artifact_count: 0,
    interrupt_count: 0,
    completeness: "complete" as const,
    wall_duration_ms: 2_000,
  }
}

function page(): RunCatalogPage {
  return {
    items: [catalogItem("run-one"), catalogItem("run-two", "failed")],
    next_cursor: null,
    as_of: "2026-07-11T14:00:00.000Z",
  }
}

function record(runId: string): RunRecord {
  return {
    schema_version: 1,
    record_revision: 2,
    run_id: runId,
    workflow_id: "review",
    workflow_revision: REVISION,
    definition_bundle_hash: REVISION,
    catalog_fingerprint: REVISION,
    execution_snapshot_hash: REVISION,
    dispatch_status: "started",
    run_status: runId === "run-two" ? "failed" : "succeeded",
    created_at: "2026-07-11T12:00:00.000Z",
    updated_at: "2026-07-11T12:00:03.000Z",
    started_at: "2026-07-11T12:00:01.000Z",
    finished_at: "2026-07-11T12:00:03.000Z",
    owner_id: "worker",
    owner_claimed_at: "2026-07-11T12:00:01.000Z",
    heartbeat_at: "2026-07-11T12:00:03.000Z",
    active_node_ids: [],
    artifact_count: 0,
    interrupt_count: 0,
    side_effects: [],
    lifecycle_projection: "exact",
    completeness: "complete",
  }
}

function graph(
  runId: string,
  revision = REVISION,
): RunGraphResponse {
  const failed = runId === "run-two"
  return {
    schema_version: 1,
    availability: "available",
    run: {
      run_id: runId,
      workflow_id: "review",
      workflow_revision: revision,
      definition_bundle_hash: REVISION,
      execution_snapshot_hash: REVISION,
      status: failed ? "failed" : "succeeded",
      completeness: "complete",
    },
    graph_hash: REVISION,
    graph: {
      state_schema_version: "1",
      nodes: [{
        id: "review",
        kind: "agent",
        capability_id: "agents.reviewer",
        can_create_pending_interrupt: false,
      }],
      edges: [],
    },
    overlay: {
      observation: "observed",
      source: "persisted",
      history: "complete",
      record_revision: 2,
      run_status: failed ? "failed" : "succeeded",
      nodes: [{
        node_id: "review",
        status: failed ? "failed" : "succeeded",
        attempt_count: failed ? 2 : 1,
      }],
    },
  }
}

function queryWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MemoryRouter>
    )
  }
}

function OverlayHarness({
  open = true,
  workflowId = "review",
}: {
  open?: boolean
  workflowId?: string
}) {
  const state = useWorkflowRunOverlay({
    workflowId,
    compiledRevision: REVISION,
    open,
  })
  const execution = state.overlay.kind === "compatible"
    ? state.overlay.execution.get("review")
    : undefined
  return (
    <>
      {open && <WorkflowRunOverlayBar state={state} onClose={vi.fn()} />}
      <output aria-label="overlay-kind">{state.overlay.kind}</output>
      <output aria-label="selected-run">{state.selectedRunId ?? "none"}</output>
      <output aria-label="node-execution">
        {execution?.status ?? "none"}:{execution?.attemptCount ?? 0}
      </output>
    </>
  )
}

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function mockRuns(revision = REVISION) {
  vi.spyOn(studioApi, "runCatalogPage").mockResolvedValue(page())
  vi.spyOn(studioApi, "run").mockImplementation(async (runId) => ({
    record: record(runId),
    status: runId === "run-two" ? "failed" : "succeeded",
    wall_duration_ms: 2_000,
  }))
  vi.spyOn(studioApi, "runGraph").mockImplementation(async (runId) =>
    graph(runId, revision))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("workflow run overlay integration", () => {
  it("applies observed node states only for the same compiled revision", async () => {
    mockRuns()
    render(<OverlayHarness />, { wrapper: queryWrapper(queryClient()) })

    await waitFor(() => expect(screen.getByLabelText("overlay-kind").textContent).toBe("compatible"))
    expect(screen.getByLabelText("node-execution").textContent).toBe("succeeded:1")
    expect(screen.getByText("Estados da execução aplicados ao canvas desta mesma revisão.")).toBeDefined()
  })

  it("shows an empty history instead of waiting on disabled run queries", async () => {
    vi.spyOn(studioApi, "runCatalogPage").mockResolvedValue({
      items: [],
      next_cursor: null,
      as_of: "2026-07-11T14:00:00.000Z",
    })
    const runSpy = vi.spyOn(studioApi, "run")
    const graphSpy = vi.spyOn(studioApi, "runGraph")
    render(<OverlayHarness />, { wrapper: queryWrapper(queryClient()) })

    expect(await screen.findByText("Este workflow ainda não possui execuções.")).toBeDefined()
    expect(runSpy).not.toHaveBeenCalled()
    expect(graphSpy).not.toHaveBeenCalled()
  })

  it("refuses a historical run from a different revision", async () => {
    mockRuns(OTHER_REVISION)
    render(<OverlayHarness />, { wrapper: queryWrapper(queryClient()) })

    await waitFor(() => expect(screen.getByLabelText("overlay-kind").textContent).toBe("revision_mismatch"))
    expect(screen.getByLabelText("node-execution").textContent).toBe("none:0")
    expect(screen.getByText(/outra revisão/)).toBeDefined()
  })

  it("loads the newly selected run and replaces the canvas state", async () => {
    mockRuns()
    render(<OverlayHarness />, { wrapper: queryWrapper(queryClient()) })

    await waitFor(() => expect(screen.getByLabelText("selected-run").textContent).toBe("run-one"))
    await waitFor(() => expect(screen.getByLabelText("node-execution").textContent).toBe("succeeded:1"))
    fireEvent.change(screen.getByRole("combobox", { name: "Execução exibida no canvas" }), {
      target: { value: "run-two" },
    })

    await waitFor(() => expect(screen.getByLabelText("selected-run").textContent).toBe("run-two"))
    await waitFor(() => expect(screen.getByLabelText("node-execution").textContent).toBe("failed:2"))
    expect(studioApi.runGraph).toHaveBeenCalledWith("run-two", expect.any(AbortSignal))
  })

  it("keeps a graph loading failure visible instead of painting stale state", async () => {
    vi.spyOn(studioApi, "runCatalogPage").mockResolvedValue(page())
    vi.spyOn(studioApi, "run").mockResolvedValue({
      record: record("run-one"),
      status: "succeeded",
      wall_duration_ms: 2_000,
    })
    vi.spyOn(studioApi, "runGraph").mockRejectedValue(new Error("graph unavailable"))
    render(<OverlayHarness />, { wrapper: queryWrapper(queryClient()) })

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Não foi possível carregar a execução selecionada.",
    )
    expect(screen.getByLabelText("node-execution").textContent).toBe("none:0")
  })

  it("removes execution paint immediately when the overlay closes", async () => {
    mockRuns()
    const client = queryClient()
    const rendered = render(<OverlayHarness />, { wrapper: queryWrapper(client) })
    await waitFor(() => expect(screen.getByLabelText("overlay-kind").textContent).toBe("compatible"))

    rendered.rerender(<OverlayHarness open={false} />)
    expect(screen.getByLabelText("overlay-kind").textContent).toBe("loading")
    expect(screen.getByLabelText("node-execution").textContent).toBe("none:0")
  })

  it("drops a selection synchronously when the editor changes workflow", async () => {
    vi.spyOn(studioApi, "runCatalogPage").mockImplementation(async (input) => {
      if (input.workflowId === "review") return page()
      return await new Promise<RunCatalogPage>(() => {})
    })
    vi.spyOn(studioApi, "run").mockImplementation(async (runId) => ({
      record: record(runId),
      status: "succeeded",
      wall_duration_ms: 2_000,
    }))
    vi.spyOn(studioApi, "runGraph").mockImplementation(async (runId) => graph(runId))
    const rendered = render(<OverlayHarness />, {
      wrapper: queryWrapper(queryClient()),
    })
    await waitFor(() => expect(screen.getByLabelText("overlay-kind").textContent).toBe("compatible"))

    rendered.rerender(<OverlayHarness workflowId="another-workflow" />)
    expect(screen.getByLabelText("selected-run").textContent).toBe("none")
    expect(screen.getByLabelText("overlay-kind").textContent).toBe("loading")
    expect(screen.getByLabelText("node-execution").textContent).toBe("none:0")
  })

  it("passes a compatible overlay into the actual design canvas boundary", async () => {
    mockRuns()
    render(
      <WorkflowDesignView
        compiled={{
          workflow_id: "review",
          workflow_revision: REVISION,
          state_schema_version: "1",
          nodes: [{
            id: "review",
            kind: "agent",
            yaml_path: "$.nodes[0]",
            capability_id: "agents.reviewer",
            can_create_pending_interrupt: false,
          }],
          edges: [],
        }}
        workflowId="review"
        draftId="draft-review"
        source={{
          nodes: [{ id: "review", type: "agent", agent: "reviewer" }],
        }}
        library={{
          technical_fingerprint: REVISION,
          presentation_fingerprint: REVISION,
          capabilities: [],
          registrations: [],
        }}
        agents={[]}
        agentCatalogComplete
        canvasLayout={{
          positions: {},
          direction: "vertical",
          pinnedNodeIds: [],
          groups: [],
        }}
        canMutate
        pending={false}
        onOperations={vi.fn()}
        onCanvasLayoutChange={vi.fn()}
        expressionFixtures={{}}
        testData={{
          entries: [],
          activeFixtureNames: new Set(),
          nodeStates: new Map(),
          panelOpen: false,
          disabled: false,
          onOpenChange: vi.fn(),
          onToggle: vi.fn(),
          onPreview: vi.fn(),
          onClearAll: vi.fn(),
          onRemove: vi.fn(),
          onEdit: vi.fn(async () => undefined),
          onDespin: vi.fn(),
        }}
        onSaveExpressionFixture={vi.fn()}
        nodeNotes={{}}
        onSaveNodeNote={vi.fn()}
        onSelectNode={vi.fn()}
        onTestThroughNode={vi.fn()}
        onTestScopedNode={vi.fn()}
      />,
      { wrapper: queryWrapper(queryClient()) },
    )

    expect(screen.getByLabelText("canvas-execution").textContent).toBe("none")
    fireEvent.click(screen.getByRole("button", { name: "Ver execução" }))
    await waitFor(() => expect(screen.getByLabelText("canvas-execution").textContent).toBe("succeeded"))
  })
})
