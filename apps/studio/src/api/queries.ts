import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"

import { studioApi } from "@/api/client"
import type {
  ArtifactList,
  GitRevisionId,
  HistoryResource,
  RunCatalogItem,
  RunGraphResponse,
  RunInterruptList,
  RunLogLevel,
  RunStatus,
} from "@/api/types"
import type { StudioPath } from "@/api/types"

const ACTIVE_RUN_REFETCH_INTERVAL_MS = 5_000
const ACTIVE_INTERRUPT_REFETCH_INTERVAL_MS = 2_000
const PERSISTENCE_CATCH_UP_INTERVAL_MS = 750
const TERMINAL_RUN_CATCH_UP_INTERVAL_MS = 2_000
const TERMINAL_RUN_CATCH_UP_WINDOW_MS = 15_000
const TERMINAL_ARTIFACT_FAST_WINDOW_MS = 10_000
const TERMINAL_ARTIFACT_BACKOFF_WINDOW_MS = 30_000
const TERMINAL_ARTIFACT_POLLING_DEADLINE_MS = 120_000
const TERMINAL_ARTIFACT_BACKOFF_INTERVAL_MS = 2_000
const TERMINAL_ARTIFACT_FINAL_INTERVAL_MS = 10_000

const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "rejected",
  "historical_unknown",
  "succeeded",
  "failed",
  "outcome_unknown",
  "timed_out",
  "cancelled",
]

export function isTerminalRunStatus(status: RunStatus | undefined): boolean {
  return status !== undefined && TERMINAL_RUN_STATUSES.includes(status)
}

export function runRefetchInterval(
  response: RunCatalogItem | undefined,
  now = Date.now(),
): number | false {
  if (response === undefined) return false
  if (!isTerminalRunStatus(response.status)) {
    return ACTIVE_RUN_REFETCH_INTERVAL_MS
  }
  const terminalAt = response.record.finished_at
  if (terminalAt === undefined) return false
  return Math.max(0, now - Date.parse(terminalAt)) < TERMINAL_RUN_CATCH_UP_WINDOW_MS
    ? TERMINAL_RUN_CATCH_UP_INTERVAL_MS
    : false
}

function runGraphRefetchInterval(
  response: RunGraphResponse | undefined,
): number | false {
  if (response?.availability === "pending") {
    return PERSISTENCE_CATCH_UP_INTERVAL_MS
  }
  if (response?.availability !== "available") return false
  if (
    response.overlay.observation === "observed" &&
    response.overlay.source === "live"
  ) {
    return ACTIVE_RUN_REFETCH_INTERVAL_MS
  }
  if (
    response.overlay.observation === "unobservable" &&
    ["run_not_started", "live_observer_unavailable"].includes(
      response.overlay.reason,
    )
  ) {
    return ACTIVE_RUN_REFETCH_INTERVAL_MS
  }
  return false
}

export function artifactsRefetchInterval(
  response: ArtifactList | undefined,
  expectedCount: number | undefined,
  terminalAt: string | undefined,
  now = Date.now(),
): number | false {
  if (response === undefined) return false
  const stillWriting = response.items.some(
    (artifact) => artifact.status === "pending",
  )
  const awaitingExpectedArtifacts =
    expectedCount !== undefined && response.items.length < expectedCount
  if (!stillWriting && !awaitingExpectedArtifacts) return false
  if (terminalAt === undefined) return PERSISTENCE_CATCH_UP_INTERVAL_MS

  const terminalAge = Math.max(0, now - Date.parse(terminalAt))
  if (terminalAge < TERMINAL_ARTIFACT_FAST_WINDOW_MS) {
    return PERSISTENCE_CATCH_UP_INTERVAL_MS
  }
  if (terminalAge < TERMINAL_ARTIFACT_BACKOFF_WINDOW_MS) {
    return TERMINAL_ARTIFACT_BACKOFF_INTERVAL_MS
  }
  if (terminalAge < TERMINAL_ARTIFACT_POLLING_DEADLINE_MS) {
    return TERMINAL_ARTIFACT_FINAL_INTERVAL_MS
  }
  return false
}

function resourceHistoryKey(resource: HistoryResource) {
  return ["studio", "resource", resource.kind, resource.id, "history"] as const
}

export const studioKeys = {
  workflows: ["studio", "workflows"] as const,
  agents: ["studio", "agents"] as const,
  library: ["studio", "library"] as const,
  draftTemplates: ["studio", "draft-templates"] as const,
  drafts: ["studio", "drafts"] as const,
  draft: (draftId: string) => ["studio", "draft", draftId] as const,
  draftSourceView: (draftId: string, file: StudioPath) =>
    ["studio", "draft", draftId, "source-view", file.root, file.path] as const,
  runs: ["studio", "runs"] as const,
  workflowRuns: (workflowId: string) =>
    ["studio", "runs", "workflow", workflowId] as const,
  runOutputComparisonCandidates: (workflowId: string) =>
    ["studio", "runs", "workflow", workflowId, "output-comparison"] as const,
  run: (runId: string) => ["studio", "run", runId] as const,
  runInterrupts: (runId: string) => ["studio", "run", runId, "interrupts"] as const,
  runGraph: (runId: string) => ["studio", "run", runId, "graph"] as const,
  runNodeOutput: (runId: string, nodeId: string) =>
    ["studio", "run", runId, "node", nodeId, "output"] as const,
  runNodeOutputComparison: (runId: string, nodeId: string, baselineRunId: string) =>
    ["studio", "run", runId, "node", nodeId, "output", "compare", baselineRunId] as const,
  timeline: (runId: string) => ["studio", "run", runId, "timeline"] as const,
  artifacts: (runId: string) => ["studio", "run", runId, "artifacts"] as const,
  artifactPreview: (runId: string, handle: string) =>
    ["studio", "run", runId, "artifact", handle, "preview"] as const,
  logs: (runId: string, levels: readonly RunLogLevel[], nodeId?: string) =>
    ["studio", "run", runId, "logs", levels, nodeId ?? ""] as const,
  inputAdapters: ["studio", "input-adapters"] as const,
  routing: ["studio", "routing"] as const,
  routingEditor: ["studio", "routing", "editor"] as const,
  workflowConfiguration: (workflowId: string) =>
    ["studio", "configuration", "workflow", workflowId] as const,
  configurationDraft: (workflowId: string, draftId: string) =>
    ["studio", "configuration", "workflow", workflowId, "draft", draftId] as const,
  configurationModels: ["studio", "configuration", "models"] as const,
  configurationRepositories: ["studio", "configuration", "repositories"] as const,
  configurationProviders: ["studio", "configuration", "providers"] as const,
  configurationRuntime: ["studio", "configuration", "runtime"] as const,
  resourceHistory: resourceHistoryKey,
  resourceHistoryCompare: (
    resource: HistoryResource,
    baseRevisionId: GitRevisionId,
    targetRevisionId: GitRevisionId,
  ) => [
    ...resourceHistoryKey(resource),
    "compare",
    baseRevisionId,
    targetRevisionId,
  ] as const,
}

export const workflowsQuery = queryOptions({
  queryKey: studioKeys.workflows,
  queryFn: ({ signal }) => studioApi.workflows(signal),
})

export const agentsQuery = queryOptions({
  queryKey: studioKeys.agents,
  queryFn: ({ signal }) => studioApi.agents(signal),
})

export const libraryQuery = queryOptions({
  queryKey: studioKeys.library,
  queryFn: ({ signal }) => studioApi.library(signal),
})

export const draftTemplatesQuery = queryOptions({
  queryKey: studioKeys.draftTemplates,
  queryFn: ({ signal }) => studioApi.draftTemplates(signal),
})

export const draftsQuery = queryOptions({
  queryKey: studioKeys.drafts,
  queryFn: ({ signal }) => studioApi.drafts(signal),
})

export const runsQuery = queryOptions({
  queryKey: studioKeys.runs,
  queryFn: ({ signal }) => studioApi.runs(signal),
  refetchInterval: 10_000,
})

export function workflowRunsQuery(workflowId: string) {
  return queryOptions({
    queryKey: studioKeys.workflowRuns(workflowId),
    queryFn: ({ signal }) => studioApi.runCatalogPage({
      workflowId,
      limit: 100,
    }, signal),
    enabled: workflowId.length > 0,
    refetchInterval: 5_000,
  })
}

export function runOutputComparisonCandidatesQuery(workflowId: string) {
  return queryOptions({
    queryKey: studioKeys.runOutputComparisonCandidates(workflowId),
    queryFn: ({ signal }) => studioApi.runCatalogPage({
      workflowId,
      limit: 100,
    }, signal),
    enabled: workflowId.length > 0,
    staleTime: 30_000,
  })
}

export function runInterruptsQuery(
  runId: string,
  active: boolean,
  terminalAt?: string,
) {
  return infiniteQueryOptions({
    queryKey: studioKeys.runInterrupts(runId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => studioApi.runInterrupts(runId, pageParam, signal),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: runId.length > 0,
    refetchInterval: (query) =>
      runInterruptsRefetchInterval(query.state.data, active, terminalAt),
  })
}

export function runInterruptsRefetchInterval(
  response: { readonly pages: readonly RunInterruptList[] } | undefined,
  active: boolean,
  terminalAt?: string,
  now = Date.now(),
): number | false {
  if (active) return ACTIVE_INTERRUPT_REFETCH_INTERVAL_MS
  if (
    terminalAt === undefined ||
    Math.max(0, now - Date.parse(terminalAt)) >= TERMINAL_RUN_CATCH_UP_WINDOW_MS
  ) return false
  const projectionPending = response === undefined || response.pages.some((page) =>
    page.items.some((interrupt) =>
      interrupt.status === "pending" || interrupt.status === "resuming"
    )
  )
  return projectionPending ? PERSISTENCE_CATCH_UP_INTERVAL_MS : false
}

export function runsInfiniteQuery(filters: {
  status?: RunStatus
  planId?: string
}) {
  return infiniteQueryOptions({
    queryKey: [...studioKeys.runs, "infinite", filters] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      studioApi.runCatalogPage(
        {
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
          ...(filters.status === undefined ? {} : { status: filters.status }),
          ...(filters.planId === undefined ? {} : { planId: filters.planId }),
        },
        signal,
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: 10_000,
  })
}

export const inputAdaptersQuery = queryOptions({
  queryKey: studioKeys.inputAdapters,
  queryFn: ({ signal }) => studioApi.inputAdapters(signal),
})

export const routingQuery = queryOptions({
  queryKey: studioKeys.routing,
  queryFn: ({ signal }) => studioApi.routing(signal),
})

export const routingEditorQuery = queryOptions({
  queryKey: studioKeys.routingEditor,
  queryFn: ({ signal }) => studioApi.routingEditor(signal),
})

export function workflowConfigurationQuery(workflowId: string) {
  return queryOptions({
    queryKey: studioKeys.workflowConfiguration(workflowId),
    queryFn: ({ signal }) => studioApi.workflowConfiguration(workflowId, signal),
    enabled: workflowId.length > 0,
  })
}

export function configurationDraftQuery(workflowId: string, draftId: string) {
  return queryOptions({
    queryKey: studioKeys.configurationDraft(workflowId, draftId),
    queryFn: ({ signal }) => studioApi.configurationDraft(workflowId, draftId, signal),
    enabled: workflowId.length > 0 && draftId.length > 0,
  })
}

export const configurationModelsQuery = queryOptions({
  queryKey: studioKeys.configurationModels,
  queryFn: ({ signal }) => studioApi.modelConfiguration(signal),
})

export const configurationRepositoriesQuery = queryOptions({
  queryKey: studioKeys.configurationRepositories,
  queryFn: ({ signal }) => studioApi.repositoryConfiguration(signal),
})

export const configurationProvidersQuery = queryOptions({
  queryKey: studioKeys.configurationProviders,
  queryFn: ({ signal }) => studioApi.providerConfiguration(signal),
})

export const configurationRuntimeQuery = queryOptions({
  queryKey: studioKeys.configurationRuntime,
  queryFn: ({ signal }) => studioApi.runtimeConfiguration(signal),
})

export function resourceHistoryQuery(resource: HistoryResource) {
  return queryOptions({
    queryKey: studioKeys.resourceHistory(resource),
    queryFn: ({ signal }) => studioApi.resourceHistory(resource, 25, signal),
    enabled: resource.id.length > 0,
  })
}

export function resourceHistoryCompareQuery(
  resource: HistoryResource,
  baseRevisionId: GitRevisionId,
  targetRevisionId: GitRevisionId,
) {
  return queryOptions({
    queryKey: studioKeys.resourceHistoryCompare(
      resource,
      baseRevisionId,
      targetRevisionId,
    ),
    queryFn: ({ signal }) => studioApi.compareResourceHistory(
      resource,
      baseRevisionId,
      targetRevisionId,
      signal,
    ),
    enabled:
      resource.id.length > 0 &&
      baseRevisionId.length > 0 &&
      targetRevisionId.length > 0 &&
      baseRevisionId !== targetRevisionId,
  })
}

export function draftQuery(draftId: string) {
  return queryOptions({
    queryKey: studioKeys.draft(draftId),
    queryFn: ({ signal }) => studioApi.draft(draftId, signal),
  })
}

export function draftSourceViewQuery(draftId: string, file: StudioPath) {
  return queryOptions({
    queryKey: studioKeys.draftSourceView(draftId, file),
    queryFn: ({ signal }) => studioApi.draftSourceView(draftId, file, signal),
  })
}

export function runQuery(runId: string) {
  return queryOptions({
    queryKey: studioKeys.run(runId),
    queryFn: ({ signal }) => studioApi.run(runId, signal),
    refetchInterval: (query) => runRefetchInterval(query.state.data),
  })
}

export function runGraphQuery(runId: string) {
  return queryOptions({
    queryKey: studioKeys.runGraph(runId),
    queryFn: ({ signal }) => studioApi.runGraph(runId, signal),
    enabled: runId.length > 0,
    refetchInterval: (query) =>
      runGraphRefetchInterval(query.state.data),
  })
}

export function runNodeOutputQuery(runId: string, nodeId: string) {
  return queryOptions({
    queryKey: studioKeys.runNodeOutput(runId, nodeId),
    queryFn: ({ signal }) => studioApi.runNodeOutput(runId, nodeId, signal),
    enabled: runId.length > 0 && nodeId.length > 0,
    staleTime: 5_000,
  })
}

export function runNodeOutputComparisonQuery(
  runId: string,
  nodeId: string,
  baselineRunId: string,
) {
  return queryOptions({
    queryKey: studioKeys.runNodeOutputComparison(runId, nodeId, baselineRunId),
    queryFn: ({ signal }) =>
      studioApi.compareRunNodeOutput(runId, nodeId, baselineRunId, signal),
    enabled: runId.length > 0 && nodeId.length > 0 && baselineRunId.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function runTimelineInfiniteQuery(
  runId: string,
  run: RunCatalogItem | undefined,
) {
  return infiniteQueryOptions({
    queryKey: studioKeys.timeline(runId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      studioApi.runTimeline(runId, pageParam, signal),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: () => runRefetchInterval(run),
  })
}

export function artifactsQuery(
  runId: string,
  options: {
    expectedCount?: number
    terminalAt?: string
  } = {},
) {
  return queryOptions({
    queryKey: studioKeys.artifacts(runId),
    queryFn: ({ signal }) => studioApi.artifacts(runId, signal),
    refetchInterval: (query) =>
      artifactsRefetchInterval(
        query.state.data,
        options.expectedCount,
        options.terminalAt,
      ),
  })
}

export function artifactPreviewQuery(runId: string, handle: string) {
  return queryOptions({
    queryKey: studioKeys.artifactPreview(runId, handle),
    queryFn: ({ signal }) => studioApi.artifactPreview(runId, handle, signal),
    enabled: handle.length > 0,
  })
}

export function runLogsInfiniteQuery(
  runId: string,
  levels: readonly RunLogLevel[],
  nodeId?: string,
) {
  return infiniteQueryOptions({
    queryKey: studioKeys.logs(runId, levels, nodeId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      studioApi.runLogs(
        runId,
        {
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
          levels: [...levels],
          ...(nodeId === undefined || nodeId.length === 0 ? {} : { nodeId }),
        },
        signal,
    ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    maxPages: 5,
  })
}
