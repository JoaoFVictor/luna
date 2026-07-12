import { describe, expect, it } from "vitest"
import { runWorkflowHref } from "@/pages/run-detail-page"

describe("runWorkflowHref", () => {
  it("returns to the exact draft used by the run", () => {
    expect(runWorkflowHref({
      workflow_id: "draft-workflow",
      definition_source: {
        kind: "draft",
        draft_id: "00000000-0000-4000-8000-000000000021",
        etag: "draft-etag",
      },
    })).toBe("/drafts/00000000-0000-4000-8000-000000000021")
  })

  it("keeps historical and installed runs on the installed workflow route", () => {
    expect(runWorkflowHref({ workflow_id: "installed workflow" }))
      .toBe("/workflows/installed%20workflow")
  })
})
