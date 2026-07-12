import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { DraftItem } from "@/api/types"
import { draftFileWriteEdits } from "@/features/drafts/draft-file-session"
import { useDraftFileSession } from "@/features/drafts/use-draft-file-session"

const FILE_KEY = "project:workflows/example/workflow.yaml"

function draft(revision: number, content: string): DraftItem {
  return {
    draft_id: "draft-example",
    record_revision: revision,
    content_revision: revision,
    layout_revision: 0,
    primary_resource: { kind: "workflow", id: "example" },
    status: "dirty",
    draft_hash: `sha256:draft-${revision}`,
    etag: `"draft-${revision}"`,
    files: [
      {
        file: { root: "project", path: "workflows/example/workflow.yaml" },
        media_type: "application/yaml",
        state: "present",
        content,
      },
    ],
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: `2026-07-11T00:00:0${revision}.000Z`,
  }
}

describe("useDraftFileSession", () => {
  it("preserves text typed after a save snapshot when its response arrives late", async () => {
    const persisted = draft(1, "persisted")
    const savedResponse = draft(2, "submitted")
    const { result, rerender } = renderHook(
      ({ serverDraft }: { serverDraft: DraftItem }) =>
        useDraftFileSession(serverDraft),
      { initialProps: { serverDraft: persisted } },
    )

    await waitFor(() => expect(result.current.workingContents[FILE_KEY]).toBe("persisted"))

    act(() => result.current.editContent(FILE_KEY, "submitted"))
    const submittedSnapshot = result.current.captureSnapshot()
    expect(submittedSnapshot).toBeDefined()

    // The user keeps typing while PATCH is in flight, even returning to the
    // previous base value. Comparing only with the old base would lose this edit.
    act(() => result.current.editContent(FILE_KEY, "persisted"))
    act(() => result.current.acceptServerDraft(savedResponse, submittedSnapshot))

    expect(result.current.baseContents[FILE_KEY]).toBe("submitted")
    expect(result.current.workingContents[FILE_KEY]).toBe("persisted")
    expect(result.current.hasLocalChanges).toBe(true)
    expect(
      draftFileWriteEdits(result.current.captureSnapshot() ?? submittedSnapshot!)[0],
    ).toMatchObject({ content: "persisted" })

    // React Query then publishes the same response through the query cache.
    // That second synchronization must remain non-destructive too.
    rerender({ serverDraft: savedResponse })
    await waitFor(() => {
      expect(result.current.workingContents[FILE_KEY]).toBe("persisted")
      expect(result.current.hasLocalChanges).toBe(true)
    })
  })

  it("preserves edits made while validate or compile is in flight", async () => {
    const initial = draft(1, "persisted")
    const commandResponse = draft(2, "persisted")
    const { result } = renderHook(() => useDraftFileSession(initial))

    await waitFor(() => expect(result.current.captureSnapshot()).toBeDefined())
    const commandSnapshot = result.current.captureSnapshot()
    expect(commandSnapshot).toBeDefined()

    act(() => result.current.editContent(FILE_KEY, "typed while compiling"))
    expect(
      result.current.operationResponseIsCurrent(
        commandResponse,
        commandSnapshot!,
      ),
    ).toBe(false)
    act(() => result.current.acceptServerDraft(commandResponse, commandSnapshot))

    expect(result.current.baseContents[FILE_KEY]).toBe("persisted")
    expect(result.current.workingContents[FILE_KEY]).toBe("typed while compiling")
    expect(result.current.hasLocalChanges).toBe(true)
  })

  it("ignores an older server response after a newer revision was accepted", async () => {
    const initial = draft(1, "one")
    const { result } = renderHook(() => useDraftFileSession(initial))

    await waitFor(() => expect(result.current.captureSnapshot()).toBeDefined())
    act(() => result.current.acceptServerDraft(draft(3, "three")))
    act(() => result.current.acceptServerDraft(draft(2, "two")))

    expect(result.current.baseContents[FILE_KEY]).toBe("three")
    expect(result.current.workingContents[FILE_KEY]).toBe("three")
  })
})
