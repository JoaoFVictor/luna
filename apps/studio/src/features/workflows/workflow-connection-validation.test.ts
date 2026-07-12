import { describe, expect, it } from "vitest"
import type { CapabilityRegistration } from "@/api/types"
import { workflowConnectionIssue } from "@/features/workflows/workflow-connection-validation"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

const nodes: WorkflowSourceNode[] = [
  { index: 0, id: "first", type: "built_in" as const, registrationId: "one", value: { id: "first" } },
  { index: 1, id: "second", type: "built_in" as const, registrationId: "two", value: { id: "second", after: ["first"] } },
]

const lifecycleRegistrations: CapabilityRegistration[] = [
  {
    registration_kind: "built_in",
    id: "one",
    owner: { capability_id: "test", capability_version: "1", capability_kind: "execution" },
    presentation: { title: "Final" },
    input_schema: {},
    output_schema: {},
    required_ports: [],
    requires_repository: false,
    deferred_lifecycle: "final_report",
  },
  {
    registration_kind: "built_in",
    id: "two",
    owner: { capability_id: "test", capability_version: "1", capability_kind: "execution" },
    presentation: { title: "Normal" },
    input_schema: {},
    output_schema: {},
    required_ports: [],
    requires_repository: false,
  },
]

describe("workflowConnectionIssue", () => {
  it("explains self, duplicate, and cyclic connections", () => {
    const edges = [{ from: "first", to: "second" }]

    expect(workflowConnectionIssue(nodes, edges, "first", "first", [])).toContain("dele mesmo")
    expect(workflowConnectionIssue(nodes, edges, "first", "second", [])).toContain("já estão conectados")
    expect(workflowConnectionIssue(nodes, edges, "second", "first", [])).toContain("criaria um ciclo")
  })

  it("accepts a new acyclic dependency", () => {
    expect(workflowConnectionIssue(nodes, [], "first", "second", [])).toBeUndefined()
  })

  it("rejects a normal dependency after a deferred final result", () => {
    expect(workflowConnectionIssue(
      nodes,
      [],
      "first",
      "second",
      lifecycleRegistrations,
    )).toContain("resultado final")
  })
})
