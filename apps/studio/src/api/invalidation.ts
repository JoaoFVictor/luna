import type { QueryClient, QueryKey } from "@tanstack/react-query"

import { studioKeys } from "@/api/queries"
import type { HistoryResource } from "@/api/types"

function appliedResourceKeys(resource: HistoryResource): readonly QueryKey[] {
  const common: readonly QueryKey[] = [
    studioKeys.drafts,
    studioKeys.library,
    studioKeys.resourceHistory(resource),
  ]
  if (resource.kind === "agent") {
    return [
      ...common,
      studioKeys.agents,
      studioKeys.workflows,
      studioKeys.configurationModels,
    ]
  }
  return [
    ...common,
    studioKeys.workflows,
    studioKeys.configurationRepositories,
    studioKeys.workflowConfiguration(resource.id),
  ]
}

export async function invalidateStudioAppliedResource(
  queryClient: QueryClient,
  resource: HistoryResource,
): Promise<void> {
  await Promise.all(
    appliedResourceKeys(resource).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  )
}
