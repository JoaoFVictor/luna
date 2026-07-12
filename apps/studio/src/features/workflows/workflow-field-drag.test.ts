import { describe, expect, it } from "vitest"

import {
  parseWorkflowFieldDragPayload,
  workflowFieldDragPayload,
} from "@/features/workflows/workflow-field-drag"

describe("workflow field drag contract", () => {
  it("round-trips a canonical workflow expression", () => {
    const payload = workflowFieldDragPayload("$.steps.context.repository.root")
    expect(parseWorkflowFieldDragPayload(payload)).toBe("$.steps.context.repository.root")
  })

  it("rejects arbitrary text and malformed payloads", () => {
    expect(parseWorkflowFieldDragPayload("$.steps.context.secret")).toBeUndefined()
    expect(parseWorkflowFieldDragPayload('{"version":2,"expression":"$.steps.x"}')).toBeUndefined()
    expect(parseWorkflowFieldDragPayload('{"version":1,"expression":"process.exit()"}')).toBeUndefined()
  })
})
