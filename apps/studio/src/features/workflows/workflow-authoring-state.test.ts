import { describe, expect, it } from "vitest"
import { workflowAuthoringStates } from "@/features/workflows/workflow-authoring-state"

describe("workflowAuthoringStates", () => {
  it("describes isolated nodes as parallel roots without claiming they are skipped", () => {
    const states = workflowAuthoringStates({
      nodes: [
        { id: "first", kind: "built_in", capability_id: "one", can_create_pending_interrupt: false },
        { id: "second", kind: "agent", capability_id: "two", can_create_pending_interrupt: false },
      ],
      edges: [],
    }, new Set(["first", "second"]))

    expect(states.get("first")).toBe("isolated")
    expect(states.get("second")).toBe("isolated")
  })

  it("does not mark a single root node as isolated", () => {
    const states = workflowAuthoringStates({
      nodes: [{ id: "only", kind: "built_in", capability_id: "one", can_create_pending_interrupt: false }],
      edges: [],
    }, new Set(["only"]))

    expect(states.get("only")).toBe("ready")
  })
})
