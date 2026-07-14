import { describe, expect, it } from "vitest"

import type { WorkflowSummary } from "@/api/types"
import {
  composableChildWorkflows,
  workflowCompositionIssue,
} from "@/features/workflows/workflow-composition-compatibility"

function child(
  id: string,
  options: Partial<Pick<WorkflowSummary, "mode" | "node_counts">> = {},
): WorkflowSummary {
  return {
    id,
    mode: options.mode ?? "read_only",
    revision: `sha256:${"a".repeat(64)}`,
    capabilities: [],
    registrations: [],
    agents: [],
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: { type: "object" },
    synchronous_composition: "allowed",
    node_counts: options.node_counts ?? {
      built_in: 1,
      agent: 0,
      pattern: 0,
      human_gate: 0,
      workflow: 0,
      loop: 0,
    },
    requires_repository: false,
    max_concurrency: 1,
  }
}

describe("workflow composition compatibility", () => {
  it("rejects write authority escalation from a read-only parent", () => {
    expect(workflowCompositionIssue(
      { mode: "read_only" },
      child("writer", { mode: "trusted_local_write" }),
    )).toMatch(/read_only/)
  })

  it("uses the catalog's resolved-tree posture instead of blocking safe nesting", () => {
    const counts = {
      built_in: 0,
      agent: 0,
      pattern: 0,
      human_gate: 0,
      workflow: 0,
      loop: 0,
    }
    expect(workflowCompositionIssue(
      { mode: "trusted_local_write" },
      {
        ...child("approval", { node_counts: { ...counts, human_gate: 1 } }),
        synchronous_composition: "blocked",
        synchronous_composition_blocked_reason: "human_input",
      },
    )).toMatch(/aprovação humana/)
    expect(workflowCompositionIssue(
      { mode: "trusted_local_write" },
      child("nested", { node_counts: { ...counts, workflow: 1 } }),
    )).toBeUndefined()
  })

  it("fails closed when the parent mode is not canonical", () => {
    expect(composableChildWorkflows({}, [child("safe")])).toEqual([])
  })
})
