import { describe, expect, it } from "vitest"

import type { InputAdapterSummary, RouterDefinition } from "@/api/types"
import { workflowEntrySources } from "@/features/workflows/workflow-entry-sources"

const adapters: InputAdapterSummary[] = [
  {
    id: "github-pr-url",
    source: "github",
    description: "GitHub PR",
    input_contract: { kind: "cli", value_type: "string" },
    preview: { enabled: true, effects: ["network_read"], timeout_ms: 1_000 },
  },
  {
    id: "plane-issue-url",
    source: "plane",
    description: "Plane issue",
    input_contract: { kind: "cli", value_type: "string" },
    preview: { enabled: false },
  },
]

const routing: RouterDefinition = {
  type: "router",
  version: "2026-06",
  rules: [
    {
      id: "github_review",
      when: { expression: "$.invocation.source = 'github' and $.invocation.event = 'pull_request'" },
      target: "workflow:code-review",
    },
    {
      id: "plane_implementation",
      when: { expression: "$.invocation.source = 'plane'" },
      target: "workflow:implementation",
    },
  ],
}

describe("workflowEntrySources", () => {
  it("shows only adapters whose deterministic route targets the workflow", () => {
    expect(workflowEntrySources(adapters, routing, "code-review")).toEqual([
      { adapter: adapters[0], ruleIds: ["github_review"] },
    ])
  })

  it("does not infer an adapter from the dynamic explicit-target rule", () => {
    expect(workflowEntrySources(adapters, {
      ...routing,
      rules: [{
        id: "explicit",
        when: { expression: "$exists($.invocation.target)" },
        target: "$.invocation.target",
      }],
    }, "code-review")).toEqual([])
  })
})
