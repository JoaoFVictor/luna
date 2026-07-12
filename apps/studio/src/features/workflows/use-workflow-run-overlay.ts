import { useCallback, useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { runGraphQuery, runQuery, workflowRunsQuery } from "@/api/queries"
import { workflowRunOverlay } from "@/features/workflows/workflow-run-overlay-model"

export function useWorkflowRunOverlay({
  workflowId,
  compiledRevision,
  open,
}: {
  workflowId: string
  compiledRevision?: string
  open: boolean
}) {
  const runs = useQuery({
    ...workflowRunsQuery(workflowId),
    enabled: open && workflowId.length > 0,
    refetchInterval: false,
  })
  const [selection, setSelection] = useState<{
    readonly workflowId: string
    readonly runId?: string
  }>({ workflowId })
  const selectedRunId = selection.workflowId === workflowId
    ? selection.runId
    : undefined
  const setSelectedRunId = useCallback((runId: string) => {
    setSelection({ workflowId, runId })
  }, [workflowId])

  useEffect(() => {
    if (!open) return
    const first = runs.data?.items[0]?.run_id
    if (
      first !== undefined &&
      (selectedRunId === undefined ||
        !runs.data?.items.some((run) => run.run_id === selectedRunId))
    ) {
      setSelection({ workflowId, runId: first })
    }
  }, [open, runs.data?.items, selectedRunId, workflowId])

  const graph = useQuery({
    ...runGraphQuery(selectedRunId ?? ""),
    enabled: open && selectedRunId !== undefined,
  })
  const run = useQuery({
    ...runQuery(selectedRunId ?? ""),
    enabled: open && selectedRunId !== undefined,
  })
  const overlay = useMemo(
    () => workflowRunOverlay(
      compiledRevision,
      open ? graph.data : undefined,
      open ? run.data?.record : undefined,
    ),
    [compiledRevision, graph.data, open, run.data?.record],
  )

  return {
    runs,
    graph,
    run,
    overlay,
    selectedRunId,
    setSelectedRunId,
  }
}
