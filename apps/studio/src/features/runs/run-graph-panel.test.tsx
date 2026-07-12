import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import { SessionContext } from "@/app/studio-context"
import type {
  ArtifactList,
  RunEvent,
  RunGraphResponse,
  RunRecord,
} from "@/api/types"
import { RunGraphPanel } from "@/features/runs/run-graph-panel"

vi.mock("@/features/workflows/workflow-graph", () => ({
  workflowGraphModel: (graph: { nodes: Array<{ id: string }> }) => graph,
  WorkflowGraph: ({ graph, execution }: {
    graph: { nodes: Array<{ id: string }> }
    execution: ReadonlyMap<string, {
      status?: string
      attemptCount?: number
      artifactCount?: number
      primaryFailure?: boolean
      supplied?: boolean
    }>
  }) => (
    <div data-testid="workflow-graph">
      {graph.nodes.map((node) => {
        const state = execution.get(node.id)
        return (
          <p key={node.id}>
            {node.id}:{state?.status ?? "unobserved"}:
            {state?.attemptCount ?? 0}:{state?.artifactCount ?? 0}:
            {state?.primaryFailure === true ? "primary" : "secondary"}:
            {state?.supplied === true ? "supplied" : "runtime"}
          </p>
        )
      })}
    </div>
  ),
  WorkflowOutline: () => <div>outline</div>,
}))

const RUN_ID = "run-graph-ui"
const DIGEST = `sha256:${"a".repeat(64)}`
const HANDLE = `ah_${"a".repeat(43)}`

const record: RunRecord = {
  schema_version: 1,
  record_revision: 4,
  run_id: RUN_ID,
  workflow_id: "code-review",
  workflow_revision: DIGEST,
  definition_bundle_hash: DIGEST,
  catalog_fingerprint: DIGEST,
  execution_snapshot_hash: DIGEST,
  dispatch_status: "started",
  run_status: "failed",
  created_at: "2026-07-11T12:00:00.000Z",
  updated_at: "2026-07-11T12:00:03.000Z",
  started_at: "2026-07-11T12:00:01.000Z",
  finished_at: "2026-07-11T12:00:03.000Z",
  owner_id: "worker-1",
  owner_claimed_at: "2026-07-11T12:00:01.000Z",
  heartbeat_at: "2026-07-11T12:00:03.000Z",
  active_node_ids: [],
  artifact_count: 2,
  interrupt_count: 0,
  failure: { code: "node_failed", message: "Node failed" },
  failed_node_id: "publish",
  side_effects: [],
  lifecycle_projection: "exact",
  completeness: "complete",
}

function graphResponse(): RunGraphResponse {
  return {
    schema_version: 1,
    availability: "available",
    run: {
      run_id: RUN_ID,
      workflow_id: "code-review",
      workflow_revision: DIGEST,
      definition_bundle_hash: DIGEST,
      execution_snapshot_hash: DIGEST,
      status: "failed",
      completeness: "complete",
    },
    graph_hash: DIGEST,
    graph: {
      state_schema_version: "2026-06",
      nodes: [
        {
          id: "review",
          kind: "agent",
          capability_id: "reviewer",
          can_create_pending_interrupt: false,
        },
        {
          id: "publish",
          kind: "built_in",
          capability_id: "artifact.publish",
          can_create_pending_interrupt: false,
        },
      ],
      edges: [{ from: "review", to: "publish" }],
    },
    overlay: {
      observation: "observed",
      source: "persisted",
      history: "complete",
      record_revision: 4,
      run_status: "failed",
      nodes: [
        { node_id: "review", status: "succeeded", attempt_count: 2 },
        { node_id: "publish", status: "failed", attempt_count: 1 },
      ],
    },
  }
}

function artifactList(): ArtifactList {
  return {
    run_id: RUN_ID,
    items: [
      {
        manifest_handle: HANDLE,
        name: "report.md",
        source_node_id: "review",
        attempt: 2,
        media_type: "text/markdown",
        status: "committed",
        created_at: "2026-07-11T12:00:02.000Z",
        preview_capability: "probe_required",
      },
      {
        manifest_handle: `ah_${"b".repeat(43)}`,
        name: "unknown.md",
        source_node_id: "not-in-graph",
        attempt: 1,
        media_type: "text/markdown",
        status: "committed",
        created_at: "2026-07-11T12:00:02.000Z",
        preview_capability: "probe_required",
      },
    ],
    redaction: "best_effort_on_preview",
  }
}

const nodeEvents: readonly RunEvent[] = [
  {
    schema_version: 1,
    run_id: RUN_ID,
    sequence: 3,
    event_id: "event-publish-started",
    event_type: "run.node.started",
    occurred_at: "2026-07-11T12:00:01.000Z",
    record_revision: 3,
    data: {
      node_event: {
        type: "node.started",
        node_id: "publish",
        attempt: 1,
        observed_at: "2026-07-11T12:00:01.000Z",
        artifact_count: 0,
        interrupt_count: 0,
      },
    },
  },
  {
    schema_version: 1,
    run_id: RUN_ID,
    sequence: 4,
    event_id: "event-publish-failed",
    event_type: "run.node.failed",
    occurred_at: "2026-07-11T12:00:02.000Z",
    record_revision: 4,
    data: {
      node_event: {
        type: "node.failed",
        node_id: "publish",
        attempt: 1,
        observed_at: "2026-07-11T12:00:02.000Z",
        artifact_count: 0,
        interrupt_count: 0,
      },
    },
  },
]

function manualTestData(nodeId: string, fixtureName: string) {
  return {
    kind: "draft_fixture" as const,
    fixture_name: fixtureName,
    node_id: nodeId,
    output_hash: DIGEST,
    source: {
      kind: "run_node_output" as const,
      run_id: `run-${nodeId}`,
      workflow_id: "code-review",
      node_id: nodeId,
      graph_hash: DIGEST,
      outcome_hash: DIGEST,
      workflow_revision: DIGEST,
      definition_bundle_hash: DIGEST,
      captured_at: "2026-07-11T12:00:00.000Z",
      redaction_changed: false,
      definition_source: { kind: "installed" as const },
    },
  }
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        <SessionContext.Provider
          value={{ bootstrap: { mode: "full" }, canMutate: true }}
        >
          {children}
        </SessionContext.Provider>
      </QueryClientProvider>
    )
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("RunGraphPanel", () => {
  it("retries a graph that is still crossing the persistence barrier", async () => {
    vi.useFakeTimers()
    const runGraph = vi.spyOn(studioApi, "runGraph")
      .mockResolvedValueOnce({
        schema_version: 1,
        availability: "pending",
        reason: "graph_not_persisted_yet",
        run: {
          run_id: RUN_ID,
          workflow_id: "code-review",
          status: "succeeded",
          completeness: "complete",
        },
      })
      .mockResolvedValue(graphResponse())
    vi.spyOn(studioApi, "artifacts").mockResolvedValue({
      run_id: RUN_ID,
      items: [],
      redaction: "best_effort_on_preview",
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const view = render(
      <RunGraphPanel runId={RUN_ID} record={record} events={[]} />,
      { wrapper: wrapper(queryClient) },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
    })
    expect(screen.getByText("Grafo aguardando persistência")).toBeDefined()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(screen.getByTestId("workflow-graph")).toBeDefined()
    expect(runGraph).toHaveBeenCalledTimes(2)
    view.unmount()
    queryClient.clear()
  })

  it("renders an explicit degraded state without inventing a graph", async () => {
    vi.spyOn(studioApi, "runGraph").mockResolvedValue({
      schema_version: 1,
      availability: "legacy",
      reason: "legacy_run_without_snapshot",
      run: {
        run_id: RUN_ID,
        workflow_id: "code-review",
        status: "failed",
        completeness: "legacy",
      },
    })
    vi.spyOn(studioApi, "artifacts").mockResolvedValue({
      run_id: RUN_ID,
      items: [],
      redaction: "best_effort_on_preview",
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(<RunGraphPanel runId={RUN_ID} record={record} events={[]} />, {
      wrapper: wrapper(queryClient),
    })

    expect(await screen.findByText("Run anterior ao snapshot de grafo")).toBeDefined()
    expect(screen.queryByTestId("workflow-graph")).toBeNull()
  })

  it("correlates only exact graph nodes with persisted status, artifacts, and failure", async () => {
    vi.spyOn(studioApi, "runGraph").mockResolvedValue(graphResponse())
    vi.spyOn(studioApi, "artifacts").mockResolvedValue(artifactList())
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(<RunGraphPanel runId={RUN_ID} record={record} events={nodeEvents} />, {
      wrapper: wrapper(queryClient),
    })

    expect(await screen.findByText("review:succeeded:2:1:secondary:runtime")).toBeDefined()
    expect(await screen.findByText("publish:failed:1:0:primary:runtime")).toBeDefined()
    expect(screen.queryByText(/not-in-graph/)).toBeNull()
    expect(screen.getAllByText(DIGEST)).toHaveLength(4)
    expect(await screen.findByText("Depuração do passo")).toBeDefined()
    expect(screen.getByText("Este passo encerrou a execução")).toBeDefined()
    expect(document.body.textContent).toContain("1.0 s")
  })

  it("selects the failure from the new run instead of retaining the previous run node", async () => {
    vi.spyOn(studioApi, "runGraph").mockResolvedValue(graphResponse())
    vi.spyOn(studioApi, "artifacts").mockResolvedValue(artifactList())
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const view = render(
      <RunGraphPanel runId={RUN_ID} record={record} events={nodeEvents} />,
      { wrapper: wrapper(queryClient) },
    )

    expect(await screen.findByRole("heading", { name: "Publish" })).toBeDefined()

    const nextRecord: RunRecord = {
      ...record,
      run_id: "run-graph-ui-next",
      failed_node_id: "review",
    }
    view.rerender(
      <RunGraphPanel
        runId="run-graph-ui-next"
        record={nextRecord}
        events={nodeEvents}
      />,
    )

    expect(await screen.findByRole("heading", { name: "Review" })).toBeDefined()
  })

  it("marks every supplied cutpoint as not executed on the immutable run graph", async () => {
    vi.spyOn(studioApi, "runGraph").mockResolvedValue(graphResponse())
    vi.spyOn(studioApi, "artifacts").mockResolvedValue(artifactList())
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const {
      failure: _failure,
      failed_node_id: _failedNodeId,
      ...recordWithoutFailure
    } = record
    const manualRecord: RunRecord = {
      ...recordWithoutFailure,
      run_status: "succeeded",
      execution_profile: {
        kind: "manual_test",
        test_data: [
          manualTestData("review", "review-output"),
          manualTestData("publish", "publish-output"),
        ],
      },
      execution_profile_hash: DIGEST,
    }

    render(<RunGraphPanel runId={RUN_ID} record={manualRecord} events={nodeEvents} />, {
      wrapper: wrapper(queryClient),
    })

    expect(await screen.findByText("review:unobserved:0:1:secondary:supplied")).toBeDefined()
    expect(await screen.findByText("publish:unobserved:0:0:secondary:supplied")).toBeDefined()
  })
})
