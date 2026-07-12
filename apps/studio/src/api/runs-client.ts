import type {
  RunExecuteRequest,
  DraftTestRunPlanInput,
  RunLogLevel,
  RunPlanInput,
  RunStatus,
} from "@/api/types"
import { studioResponseContracts } from "@/api/response-contracts"
import {
  STUDIO_API_PREFIX,
  type StudioRequest,
} from "@/api/client-core"
import { StudioRunPlanInputSchema } from "../../../../src/studio/contracts/run-plan-input.js"
import { StudioRunExecuteRequestSchema } from "../../../../src/studio/contracts/run-launch.js"
import { StudioDraftTestRunPlanInputSchema } from "../../../../src/studio/contracts/draft-test-run.js"

export type StudioRunCatalogQuery = {
  cursor?: string
  limit?: number
  status?: RunStatus
  workflowId?: string
  source?: string
  planId?: string
}

export type StudioRunLogQuery = {
  cursor?: string
  levels?: RunLogLevel[]
  nodeId?: string
  limit?: number
}

export class StudioRunsClient {
  readonly #request: StudioRequest

  constructor(request: StudioRequest) {
    this.#request = request
  }

  readonly runs = (signal?: AbortSignal) => {
    return this.runCatalogPage({ limit: 20 }, signal)
  }

  readonly planRun = (input: RunPlanInput, signal?: AbortSignal) => {
    const body = StudioRunPlanInputSchema.parse(input)
    return this.#request(
      "/run-plans",
      {
        method: "POST",
        body,
        ...(signal === undefined ? {} : { signal }),
      },
      studioResponseContracts.runPlan,
    )
  }

  readonly planDraftTestRun = (
    draftId: string,
    input: DraftTestRunPlanInput,
    signal?: AbortSignal,
  ) => {
    const body = StudioDraftTestRunPlanInputSchema.parse(input)
    return this.#request(
      `/drafts/${encodeURIComponent(draftId)}/run-plans`,
      {
        method: "POST",
        body,
        ...(signal === undefined ? {} : { signal }),
      },
      studioResponseContracts.runPlan,
    )
  }

  readonly executeRun = (
    planId: string,
    input: RunExecuteRequest,
    signal?: AbortSignal,
  ) => {
    const body = StudioRunExecuteRequestSchema.parse(input)
    return this.#request(
      `/run-plans/${encodeURIComponent(planId)}/execute`,
      {
        method: "POST",
        body,
        ...(signal === undefined ? {} : { signal }),
      },
      studioResponseContracts.runDispatchReceipt,
    )
  }

  readonly runCatalogPage = (
    query: StudioRunCatalogQuery,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({
      limit: String(query.limit ?? 100),
      direction: "desc",
    })
    if (query.cursor !== undefined) params.set("cursor", query.cursor)
    if (query.status !== undefined) params.set("status", query.status)
    if (query.workflowId !== undefined) params.set("workflow_id", query.workflowId)
    if (query.source !== undefined) params.set("source", query.source)
    if (query.planId !== undefined) params.set("plan_id", query.planId)
    return this.#request(
      `/runs?${params.toString()}`,
      { signal },
      studioResponseContracts.runCatalog,
    )
  }

  readonly run = (runId: string, signal?: AbortSignal) => {
    return this.#request(
      `/runs/${encodeURIComponent(runId)}`,
      { signal },
      studioResponseContracts.run,
    )
  }

  readonly runGraph = (runId: string, signal?: AbortSignal) => {
    return this.#request(
      `/runs/${encodeURIComponent(runId)}/graph`,
      { signal },
      studioResponseContracts.runGraph,
    )
  }

  readonly runNodeOutput = (
    runId: string,
    nodeId: string,
    signal?: AbortSignal,
  ) => {
    return this.#request(
      `/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/output`,
      { signal },
      studioResponseContracts.runNodeOutput,
    )
  }

  readonly compareRunNodeOutput = (
    runId: string,
    nodeId: string,
    baselineRunId: string,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ baseline_run_id: baselineRunId })
    return this.#request(
      `/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/output/compare?${query.toString()}`,
      { signal },
      studioResponseContracts.runNodeOutputComparison,
    )
  }

  readonly runTimeline = (
    runId: string,
    cursor?: string,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({ limit: "100", direction: "desc" })
    if (cursor !== undefined) params.set("cursor", cursor)
    return this.#request(
      `/runs/${encodeURIComponent(runId)}/timeline?${params.toString()}`,
      { signal },
      studioResponseContracts.runTimeline,
    )
  }

  readonly runEventStreamUrl = (
    runId: string,
    afterSequence: number,
  ): string => {
    const params = new URLSearchParams({
      after_sequence: String(afterSequence),
    })
    return `${STUDIO_API_PREFIX}/runs/${encodeURIComponent(runId)}/events/stream?${params.toString()}`
  }

  readonly artifacts = (runId: string, signal?: AbortSignal) => {
    return this.#request(
      `/runs/${encodeURIComponent(runId)}/artifacts`,
      { signal },
      studioResponseContracts.artifacts,
    )
  }

  readonly artifactMetadata = (
    runId: string,
    handle: string,
    signal?: AbortSignal,
  ) => {
    return this.#request(
      `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(handle)}`,
      { signal },
      studioResponseContracts.artifactMetadata,
    )
  }

  readonly artifactPreview = (
    runId: string,
    handle: string,
    signal?: AbortSignal,
  ) => {
    return this.#request(
      `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(handle)}/preview`,
      { signal },
      studioResponseContracts.artifactPreview,
    )
  }

  readonly artifactDownloadUrl = (runId: string, handle: string): string => {
    return `${STUDIO_API_PREFIX}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(handle)}/download`
  }

  readonly runLogs = (
    runId: string,
    query: StudioRunLogQuery,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({ limit: String(query.limit ?? 100) })
    if (query.cursor !== undefined) params.set("cursor", query.cursor)
    if (query.levels !== undefined && query.levels.length > 0) {
      params.set("levels", query.levels.join(","))
    }
    if (query.nodeId !== undefined) params.set("node_id", query.nodeId)
    return this.#request(
      `/runs/${encodeURIComponent(runId)}/logs?${params.toString()}`,
      { signal },
      studioResponseContracts.runLogs,
    )
  }
}
