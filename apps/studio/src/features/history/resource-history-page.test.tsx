import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import type {
  ResourceHistory,
  ResourceHistoryCompare,
  ResourceHistoryRestore,
} from "@/api/types"
import { SessionContext } from "@/app/studio-context"
import { AgentResourceHistoryPage } from "@/pages/resource-history-page"

const BASE_REVISION = "a".repeat(40)
const TARGET_REVISION = "b".repeat(40)
const DRAFT_ID = "5bbc0ae8-d9f1-4cc2-b704-8186c026ad38"
const DIGEST = `sha256:${"c".repeat(64)}`
const RESOURCE = { kind: "agent", id: "reviewer" } as const
const PRIVATE_CANARY = "PRIVATE_TOKEN_must_never_render"

const history: ResourceHistory = {
  resource: RESOURCE,
  revisions: [
    {
      revision_id: TARGET_REVISION,
      committed_at: "2026-07-11T12:00:00.000Z",
      subject: "Update reviewer",
    },
    {
      revision_id: BASE_REVISION,
      committed_at: "2026-07-10T12:00:00.000Z",
      subject: "Create reviewer",
    },
  ],
  truncated: false,
}

const comparison: ResourceHistoryCompare = {
  resource: RESOURCE,
  base_revision_id: BASE_REVISION,
  target_revision_id: TARGET_REVISION,
  diff: [
    {
      file: { root: "project", path: "agents/reviewer/agent.yaml" },
      kind: "modified",
      before_sha256: DIGEST,
      after_sha256: `sha256:${"d".repeat(64)}`,
      before_mode: 0o644,
      after_mode: 0o644,
      textual_diff: "@@ -1 +1 @@\n-[REDACTED]\n+[REDACTED]\n",
      textual_diff_truncated: false,
      redacted: true,
    },
  ],
}

const restored: ResourceHistoryRestore = {
  resource: RESOURCE,
  revision_id: TARGET_REVISION,
  draft: {
    draft_id: DRAFT_ID,
    record_revision: 1,
    content_revision: 1,
    layout_revision: 0,
    primary_resource: RESOURCE,
    status: "dirty",
    draft_hash: DIGEST,
    etag: `"studio-draft:${DRAFT_ID}:1:${DIGEST}"`,
    files: [],
    created_at: "2026-07-11T12:00:00.000Z",
    updated_at: "2026-07-11T12:00:00.000Z",
  },
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        <SessionContext.Provider
          value={{ bootstrap: { mode: "full" }, canMutate: true }}
        >
          <MemoryRouter initialEntries={["/agents/reviewer/history"]}>
            {children}
          </MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>
    )
  }
}

function renderHistory() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  render(
    <Routes>
      <Route
        path="/agents/:resourceId/history"
        element={<AgentResourceHistoryPage />}
      />
      <Route
        path="/agent-drafts/:draftId"
        element={<p>historical-draft-destination</p>}
      />
    </Routes>,
    { wrapper: wrapper(queryClient) },
  )
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("ResourceHistoryPage", () => {
  it("compares the two newest revisions and renders only the redacted diff", async () => {
    vi.spyOn(studioApi, "resourceHistory").mockResolvedValue(history)
    const compare = vi
      .spyOn(studioApi, "compareResourceHistory")
      .mockResolvedValue(comparison)

    renderHistory()

    expect(await screen.findByText("Update reviewer")).toBeDefined()
    expect(screen.getByText("Create reviewer")).toBeDefined()
    expect(await screen.findByText(/\[REDACTED\]/)).toBeDefined()
    expect(document.body.textContent).not.toContain(PRIVATE_CANARY)
    await waitFor(() => expect(compare).toHaveBeenCalledWith(
      RESOURCE,
      BASE_REVISION,
      TARGET_REVISION,
      expect.any(AbortSignal),
    ))
  })

  it("requires the explicit dialog before creating and opening a normal draft", async () => {
    vi.spyOn(studioApi, "resourceHistory").mockResolvedValue(history)
    vi.spyOn(studioApi, "compareResourceHistory").mockResolvedValue(comparison)
    const restore = vi
      .spyOn(studioApi, "restoreResourceHistory")
      .mockResolvedValue(restored)

    renderHistory()
    await screen.findByText("Update reviewer")
    fireEvent.click(
      screen.getByRole("button", { name: "Criar draft da revisão alvo" }),
    )

    expect(
      await screen.findByRole("heading", {
        name: "Criar draft da revisão histórica?",
      }),
    ).toBeDefined()
    expect(restore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Criar novo draft" }))

    expect(await screen.findByText("historical-draft-destination")).toBeDefined()
    expect(restore).toHaveBeenCalledWith(RESOURCE, TARGET_REVISION)
  })
})
