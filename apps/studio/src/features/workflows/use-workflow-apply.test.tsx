import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import type { ApplyPlan, DraftItem } from "@/api/types"
import { useWorkflowApply } from "@/features/workflows/use-workflow-apply"

const DRAFT_ID = "e65b7c61-e03e-49e0-b9ca-6c20977d68ec"
const DIGEST = `sha256:${"a".repeat(64)}`

const draft: DraftItem = {
  draft_id: DRAFT_ID,
  record_revision: 1,
  content_revision: 1,
  layout_revision: 0,
  primary_resource: { kind: "workflow", id: "review" },
  status: "valid",
  draft_hash: DIGEST,
  etag: '"draft-1"',
  files: [],
  created_at: "2026-07-11T00:00:00.000Z",
  updated_at: "2026-07-11T00:00:00.000Z",
}

const plan: ApplyPlan = {
  status: "ready",
  draft_id: DRAFT_ID,
  record_revision: 1,
  content_revision: 1,
  draft_hash: DIGEST,
  diff: [],
  conflicts: [],
  resources: [{ kind: "workflow", id: "review" }],
  plan_token: "p".repeat(32),
  expires_at: "2026-07-11T01:00:00.000Z",
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    )
  }
}

afterEach(() => vi.restoreAllMocks())

describe("useWorkflowApply", () => {
  it("reuses the confirmed idempotency key when an apply outcome is unknown", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    })
    vi.spyOn(studioApi, "planApply").mockResolvedValue(plan)
    const apply = vi
      .spyOn(studioApi, "applyDraft")
      .mockRejectedValue(new Error("acceptance unknown"))
    const { result } = renderHook(
      () => useWorkflowApply({
        draftId: DRAFT_ID,
        draft,
        refetchDraft: vi.fn().mockResolvedValue(undefined),
      }),
      { wrapper: wrapper(queryClient) },
    )

    act(() => result.current.planApply(true))
    await waitFor(() => expect(result.current.plan?.status).toBe("ready"))

    act(() => result.current.apply())
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    act(() => result.current.apply())
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2))

    expect(apply.mock.calls[0]?.[3]).toBe(apply.mock.calls[1]?.[3])
    expect(apply.mock.calls[0]?.slice(0, 3)).toEqual([
      DRAFT_ID,
      draft.etag,
      plan.plan_token,
    ])
  })
})
