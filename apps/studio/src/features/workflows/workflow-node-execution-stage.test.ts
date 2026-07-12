import { describe, expect, it } from "vitest"

import type { CapabilityRegistration } from "@/api/types"
import {
  workflowDependencyExecutionStageIssue,
  workflowNodeInsertionExecutionStageIssue,
} from "@/features/workflows/workflow-node-execution-stage"
import { workflowSourceNodes } from "@/features/workflows/workflow-source-model"

const common = {
  owner: { capability_id: "reports", capability_version: "1", capability_kind: "execution" as const },
  input_schema: { type: "object" },
  output_schema: { type: "object" },
  required_ports: [],
  requires_repository: false,
}

const registrations: CapabilityRegistration[] = [
  {
    ...common,
    registration_kind: "built_in",
    id: "reports.final_report",
    presentation: { title: "Gerar relatório final" },
    deferred_lifecycle: "final_report",
  },
  {
    ...common,
    registration_kind: "built_in",
    id: "task-context.collect",
    presentation: { title: "Coletar dados da tarefa" },
  },
]

describe("workflow execution-stage placement", () => {
  it("prevents a normal step from depending on a deferred final result", () => {
    expect(workflowDependencyExecutionStageIssue(
      registrations,
      { kind: "built_in", registrationId: "reports.final_report" },
      { kind: "built_in", registrationId: "task-context.collect" },
    )).toContain("depois das etapas normais")
  })

  it("accepts normal work before the final result", () => {
    expect(workflowDependencyExecutionStageIssue(
      registrations,
      { kind: "built_in", registrationId: "task-context.collect" },
      { kind: "built_in", registrationId: "reports.final_report" },
    )).toBeUndefined()
  })

  it("rejects inserting a final result into an edge that still has normal work", () => {
    const nodes = workflowSourceNodes({
      nodes: [
        { id: "first", type: "built_in", uses: "task-context.collect" },
        { id: "second", type: "built_in", uses: "task-context.collect", after: ["first"] },
      ],
    })
    expect(workflowNodeInsertionExecutionStageIssue(
      registrations,
      nodes,
      { kind: "built_in", registrationId: "reports.final_report" },
      "first",
      "second",
    )).toContain("depois das etapas normais")
  })
})
