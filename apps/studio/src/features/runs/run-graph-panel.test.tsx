import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import type {
  ArtifactList,
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
    }>
  }) => (
    <div data-testid="workflow-graph">
      {graph.nodes.map((node) => {
        const state = execution.get(node.id)
        return (
          <p key={node.id}>
            {node.id}:{state?.status ?? "unobserved"}:
            {state?.attemptCount ?? 0}:{state?.artifactCount ?? 0}:
            {state?.primaryFailure === true ? "primary" : "secondary"}
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

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("RunGraphPanel", () => {
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

    render(<RunGraphPanel runId={RUN_ID} record={record} />, {
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

    render(<RunGraphPanel runId={RUN_ID} record={record} />, {
      wrapper: wrapper(queryClient),
    })

    expect(await screen.findByText("review:succeeded:2:1:secondary")).toBeDefined()
    expect(await screen.findByText("publish:failed:1:0:primary")).toBeDefined()
    expect(screen.queryByText(/not-in-graph/)).toBeNull()
    expect(screen.getAllByText(DIGEST)).toHaveLength(4)
  })
})
