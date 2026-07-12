import { describe, expect, it } from "vitest"

import { draftHref, workflowDraftTestDataHref } from "./draft-route"

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

describe("workflowDraftTestDataHref", () => {
  it("encodes an editor deep link that activates an eligible fixture for its source node", () => {
    expect(workflowDraftTestDataHref("draft/id", {
      fixtureName: "approved review",
      nodeId: "review/node",
    })).toBe("/drafts/draft%2Fid?panel=test-data&test_data=approved+review&fixture=approved+review&node=review%2Fnode")
  })
})
