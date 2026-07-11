import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioAgentTestBenchApi } from "@/api/agent-test-bench"
import { AgentDraftTestBench } from "./agent-draft-test-bench"

const draftId = "11111111-1111-4111-8111-111111111111"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("AgentDraftTestBench", () => {
  it("pins the saved draft id and ETag in the authoritative plan request", async () => {
    const plan = vi.spyOn(studioAgentTestBenchApi, "plan")
      .mockRejectedValue(new Error("plan request observed"))

    render(
      <AgentDraftTestBench
        draftId={draftId}
        etag="draft-etag-7"
        canMutate
        hasLocalChanges={false}
        pending={false}
      />,
    )

    expect(screen.getByText(`draft salvo · ${draftId}`)).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Gerar preview efetivo" }))

    await waitFor(() => expect(plan).toHaveBeenCalledWith({
      target: { kind: "draft", draft_id: draftId, etag: "draft-etag-7" },
      fixture: {},
      context: { kind: "none" },
    }, expect.any(AbortSignal)))
    expect(await screen.findByText("plan request observed")).toBeDefined()
  })

  it("does not expose planning while local changes are newer than the saved draft", () => {
    render(
      <AgentDraftTestBench
        draftId={draftId}
        etag="draft-etag-7"
        canMutate
        hasLocalChanges
        pending={false}
      />,
    )

    expect(screen.getByText("Salve o draft antes do Test Bench")).toBeDefined()
    expect(screen.queryByRole("button", { name: "Gerar preview efetivo" })).toBeNull()
  })

  it("fails closed while the session lacks mutation authority", () => {
    render(
      <AgentDraftTestBench
        draftId={draftId}
        etag="draft-etag-7"
        canMutate={false}
        hasLocalChanges={false}
        pending={false}
      />,
    )

    expect(screen.getByText("Test Bench indisponível nesta sessão")).toBeDefined()
    expect(screen.queryByRole("button", { name: "Gerar preview efetivo" })).toBeNull()
  })
})
