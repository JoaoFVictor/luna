import { describe, expect, it } from "vitest"

import { routingRuleDescription } from "@/features/configuration/routing-presentation"

describe("routingRuleDescription", () => {
  it("translates the common deterministic routing expression", () => {
    expect(routingRuleDescription({
      id: "github",
      when: { expression: "$.invocation.source = 'github' and $.invocation.event = 'pull_request' and $.invocation.action in ['opened', 'reopened']" },
      target: "workflow:code-review",
    })).toBe("Se origem é GitHub e evento é Pull request e ação é Opened, Reopened, enviar para Code review")
  })

  it("explains the explicit target rule without exposing JSONata", () => {
    expect(routingRuleDescription({
      id: "explicit",
      when: { expression: "$exists($.invocation.target)" },
      target: "$.invocation.target",
    })).toContain("respeitar esse workflow")
  })
})
