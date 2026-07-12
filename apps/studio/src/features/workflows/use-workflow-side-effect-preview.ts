import { useMemo } from "react"
import type { UseQueryResult } from "@tanstack/react-query"

import type { AgentCatalog, CapabilityCatalog, DraftSourceView } from "@/api/types"
import { authoringAuthorityUnavailable } from "@/features/drafts/authoring-authority"
import { workflowSideEffectPreview, type WorkflowSideEffectPreview } from "./workflow-side-effect-preview"

const UNKNOWN_SIDE_EFFECTS: readonly WorkflowSideEffectPreview[] = [{
  nodeId: "workflow",
  source: "agent_tools",
  semantics: "unknown",
  description: "Catálogos de capabilities/agents ainda indisponíveis; side effects não podem ser descartados",
  operationIds: [],
}]

export function useWorkflowSideEffectProjection({
  hasLocalChanges,
  sourceView,
  library,
  agents,
}: {
  hasLocalChanges: boolean
  sourceView: UseQueryResult<DraftSourceView>
  library: UseQueryResult<CapabilityCatalog>
  agents: UseQueryResult<AgentCatalog>
}): readonly WorkflowSideEffectPreview[] {
  return useMemo(() => {
    if (authoringAuthorityUnavailable(hasLocalChanges, [sourceView, library, agents]) || sourceView.data === undefined || library.data === undefined || agents.data === undefined) return UNKNOWN_SIDE_EFFECTS
    return workflowSideEffectPreview(sourceView.data.value, library.data, agents.data.agents, agents.data.status === "complete")
  }, [agents, hasLocalChanges, library, sourceView])
}
