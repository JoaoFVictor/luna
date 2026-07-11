import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import type { RunCatalogPage, RunRecord } from "@/api/types"
import { WorkflowRunsPanel } from "@/features/workflows/workflow-runs-panel"

vi.mock("@/features/runs/run-graph-panel", () => ({
  RunGraphPanel: ({ runId }: { runId: string }) => (
    <div data-testid="run-graph">snapshot:{runId}</div>
  ),
}))

const DIGEST = `sha256:${"a".repeat(64)}`
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`
const RUN_ID = "run-workflow-tab"

function record(workflowRevision = DIGEST): RunRecord {
  return {
    schema_version: 1,
    record_revision: 4,
    run_id: RUN_ID,
    workflow_id: "code-review",
    workflow_revision: workflowRevision,
    definition_bundle_hash: DIGEST,
    catalog_fingerprint: DIGEST,
    execution_snapshot_hash: DIGEST,
    dispatch_status: "started",
    run_status: "succeeded",
    created_at: "2026-07-11T12:00:00.000Z",
    updated_at: "2026-07-11T12:00:03.000Z",
    started_at: "2026-07-11T12:00:01.000Z",
    finished_at: "2026-07-11T12:00:03.000Z",
    owner_id: "worker-1",
    owner_claimed_at: "2026-07-11T12:00:01.000Z",
    heartbeat_at: "2026-07-11T12:00:03.000Z",
    active_node_ids: [],
    artifact_count: 1,
    interrupt_count: 0,
    side_effects: [],
    lifecycle_projection: "exact",
    completeness: "complete",
  }
}

function page(workflowRevision = DIGEST): RunCatalogPage {
  return {
    items: [{
      run_id: RUN_ID,
      workflow_id: "code-review",
      workflow_revision: workflowRevision,
      execution_snapshot_hash: DIGEST,
      dispatch_status: "started",
      run_status: "succeeded",
      status: "succeeded",
      created_at: "2026-07-11T12:00:00.000Z",
      started_at: "2026-07-11T12:00:01.000Z",
      finished_at: "2026-07-11T12:00:03.000Z",
      artifact_count: 1,
      interrupt_count: 0,
      completeness: "complete",
      wall_duration_ms: 2_000,
    }],
    next_cursor: null,
    as_of: "2026-07-11T12:00:04.000Z",
  }
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MemoryRouter>
    )
  }
}

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("WorkflowRunsPanel", () => {
  it("filters runs by workflow and shows the exact persisted graph snapshot", async () => {
    const catalog = vi.spyOn(studioApi, "runCatalogPage").mockResolvedValue(page())
    vi.spyOn(studioApi, "run").mockResolvedValue({
      record: record(),
      status: "succeeded",
      wall_duration_ms: 2_000,
    })

    render(
      <WorkflowRunsPanel workflowId="code-review" compiledRevision={DIGEST} />,
      { wrapper: wrapper(queryClient()) },
    )

    expect(await screen.findByText("Mesma revisão compilada")).toBeDefined()
    expect(screen.getByTestId("run-graph").textContent).toBe(`snapshot:${RUN_ID}`)
    expect(catalog).toHaveBeenCalledWith(
      { workflowId: "code-review", limit: 100 },
      expect.any(AbortSignal),
    )
  })

  it("warns instead of presenting a historical graph as the current draft", async () => {
    vi.spyOn(studioApi, "runCatalogPage").mockResolvedValue(page(OTHER_DIGEST))
    vi.spyOn(studioApi, "run").mockResolvedValue({
      record: record(OTHER_DIGEST),
      status: "succeeded",
      wall_duration_ms: 2_000,
    })

    render(
      <WorkflowRunsPanel workflowId="code-review" compiledRevision={DIGEST} />,
      { wrapper: wrapper(queryClient()) },
    )

    expect(await screen.findByText("Revisões diferentes")).toBeDefined()
    expect(screen.getByText(/não representa o draft atual/)).toBeDefined()
  })

  it("renders an actionable empty state without requesting run detail", async () => {
    vi.spyOn(studioApi, "runCatalogPage").mockResolvedValue({
      items: [],
      next_cursor: null,
      as_of: "2026-07-11T12:00:04.000Z",
    })
    const detail = vi.spyOn(studioApi, "run")

    render(
      <WorkflowRunsPanel workflowId="code-review" />,
      { wrapper: wrapper(queryClient()) },
    )

    expect(await screen.findByText("Este workflow ainda não foi executado")).toBeDefined()
    expect(screen.getByRole("link", { name: "Testar workflow" })).toBeDefined()
    await waitFor(() => expect(detail).not.toHaveBeenCalled())
  })
})
