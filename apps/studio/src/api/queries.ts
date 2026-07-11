import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"

import { studioApi } from "@/api/client"
import type {
  GitRevisionId,
  HistoryResource,
  RunLogLevel,
  RunStatus,
} from "@/api/types"
import type { StudioPath } from "@/api/types"

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
  run: (runId: string) => ["studio", "run", runId] as const,
  runGraph: (runId: string) => ["studio", "run", runId, "graph"] as const,
  timeline: (runId: string) => ["studio", "run", runId, "timeline"] as const,
  artifacts: (runId: string) => ["studio", "run", runId, "artifacts"] as const,
  artifactPreview: (runId: string, handle: string) =>
    ["studio", "run", runId, "artifact", handle, "preview"] as const,
  logs: (runId: string, levels: readonly RunLogLevel[]) =>
    ["studio", "run", runId, "logs", levels] as const,
  inputAdapters: ["studio", "input-adapters"] as const,
  routing: ["studio", "routing"] as const,
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
    refetchInterval: 5_000,
  })
}

export function runGraphQuery(runId: string) {
  return queryOptions({
    queryKey: studioKeys.runGraph(runId),
    queryFn: ({ signal }) => studioApi.runGraph(runId, signal),
    enabled: runId.length > 0,
    refetchInterval: 5_000,
  })
}

export function runTimelineInfiniteQuery(runId: string) {
  return infiniteQueryOptions({
    queryKey: studioKeys.timeline(runId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      studioApi.runTimeline(runId, pageParam, signal),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: 5_000,
  })
}

export function artifactsQuery(runId: string) {
  return queryOptions({
    queryKey: studioKeys.artifacts(runId),
    queryFn: ({ signal }) => studioApi.artifacts(runId, signal),
    refetchInterval: 5_000,
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
) {
  return infiniteQueryOptions({
    queryKey: studioKeys.logs(runId, levels),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      studioApi.runLogs(
        runId,
        {
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
          levels: [...levels],
        },
        signal,
    ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    maxPages: 5,
  })
}
