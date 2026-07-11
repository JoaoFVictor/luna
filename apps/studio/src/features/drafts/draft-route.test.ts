import { describe, expect, it } from "vitest"

import { draftHref } from "./draft-route"

describe("draftHref", () => {
  it("routes workflow and agent drafts to their editors", () => {
    expect(draftHref({
      draft_id: "workflow-draft",
      primary_resource: { kind: "workflow", id: "review" },
    })).toBe("/drafts/workflow-draft")
    expect(draftHref({
      draft_id: "agent/draft",
      primary_resource: { kind: "agent", id: "reviewer" },
    })).toBe("/agent-drafts/agent%2Fdraft")
  })

  it("routes configuration drafts back to the owning workflow panel", () => {
    expect(draftHref({
      draft_id: "config draft",
      primary_resource: { kind: "config", id: "review/workflow" },
    })).toBe("/configuration?workflow=review%2Fworkflow&draft=config+draft")
  })
})
