import type { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

import { invalidateStudioAppliedResource } from "@/api/invalidation"
import { studioKeys } from "@/api/queries"

function queryClientSpy() {
  const invalidateQueries = vi.fn().mockResolvedValue(undefined)
  return {
    client: { invalidateQueries } as unknown as QueryClient,
    invalidateQueries,
  }
}

describe("applied resource query invalidation", () => {
  it("invalidates every projection derived from an agent", async () => {
    const { client, invalidateQueries } = queryClientSpy()
    const resource = { kind: "agent", id: "reviewer" } as const

    await invalidateStudioAppliedResource(client, resource)

    expect(invalidateQueries.mock.calls.map(([input]) => input.queryKey))
      .toEqual([
        studioKeys.drafts,
        studioKeys.library,
        studioKeys.resourceHistory(resource),
        studioKeys.agents,
        studioKeys.workflows,
        studioKeys.configurationModels,
      ])
  })

  it("invalidates workflow config descendants and repository consumers", async () => {
    const { client, invalidateQueries } = queryClientSpy()
    const resource = { kind: "workflow", id: "review-flow" } as const

    await invalidateStudioAppliedResource(client, resource)

    expect(invalidateQueries.mock.calls.map(([input]) => input.queryKey))
      .toEqual([
        studioKeys.drafts,
        studioKeys.library,
        studioKeys.resourceHistory(resource),
        studioKeys.workflows,
        studioKeys.configurationRepositories,
        studioKeys.workflowConfiguration(resource.id),
      ])
  })
})
