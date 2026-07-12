import type { ArtifactSummary, RunGraphResponse, RunRecord } from "@/api/types"
import type { WorkflowNodeExecution } from "@/features/workflows/workflow-execution-presentation"

export type WorkflowRunOverlayCompatibility =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "revision_mismatch"; readonly runRevision?: string }
  | { readonly kind: "compatible"; readonly execution: ReadonlyMap<string, WorkflowNodeExecution> }

type WorkflowRunOverlayRecord = Pick<
  RunRecord,
  "execution_profile" | "failed_node_id" | "failure"
>

type AvailableRunGraph = Extract<RunGraphResponse, { readonly availability: "available" }>

export function workflowRunExecutionProjection(
  response: AvailableRunGraph,
  record: WorkflowRunOverlayRecord | undefined,
  artifacts: readonly ArtifactSummary[] = [],
): ReadonlyMap<string, WorkflowNodeExecution> {
  const execution = new Map<string, WorkflowNodeExecution>()
  const graphNodeIds = new Set(response.graph.nodes.map((node) => node.id))
  if (response.overlay.observation === "observed") {
    for (const node of response.overlay.nodes) {
      if (!graphNodeIds.has(node.node_id)) continue
      execution.set(node.node_id, {
        status: node.status,
        ...(node.attempt_count === undefined
          ? {}
          : { attemptCount: node.attempt_count }),
      })
    }
  }

  if (record?.execution_profile?.kind === "manual_test") {
    for (const testData of record.execution_profile.test_data) {
      if (!graphNodeIds.has(testData.node_id)) continue
      const {
        status: _runtimeStatus,
        attemptCount: _runtimeAttempts,
        ...remainingExecution
      } = execution.get(testData.node_id) ?? {}
      execution.set(testData.node_id, {
        ...remainingExecution,
        supplied: true,
      })
    }
  }

  const artifactCounts = new Map<string, number>()
  for (const artifact of artifacts) {
    if (
      artifact.source_node_id === undefined ||
      !graphNodeIds.has(artifact.source_node_id)
    ) continue
    artifactCounts.set(
      artifact.source_node_id,
      (artifactCounts.get(artifact.source_node_id) ?? 0) + 1,
    )
  }
  for (const [nodeId, artifactCount] of artifactCounts) {
    execution.set(nodeId, { ...execution.get(nodeId), artifactCount })
  }

  if (
    record?.failure !== undefined &&
    record.failed_node_id !== undefined &&
    graphNodeIds.has(record.failed_node_id)
  ) {
    execution.set(record.failed_node_id, {
      ...execution.get(record.failed_node_id),
      primaryFailure: true,
    })
  }
  return execution
}

export function workflowRunOverlay(
  compiledRevision: string | undefined,
  response: RunGraphResponse | undefined,
  record: WorkflowRunOverlayRecord | undefined,
): WorkflowRunOverlayCompatibility {
  if (response === undefined) return { kind: "loading" }
  if (response.availability !== "available") {
    return {
      kind: "unavailable",
      reason: response.reason,
    }
  }
  if (
    compiledRevision === undefined ||
    response.run.workflow_revision !== compiledRevision
  ) {
    return {
      kind: "revision_mismatch",
      runRevision: response.run.workflow_revision,
    }
  }

  return {
    kind: "compatible",
    execution: workflowRunExecutionProjection(response, record),
  }
}
