import { describe, expect, it } from "vitest"

import { routingRuleDescription } from "@/features/configuration/routing-presentation"

describe("routingRuleDescription", () => {
  it("translates the common deterministic routing expression", () => {
    expect(routingRuleDescription({
      id: "vendor-work-item",
      when: { expression: "$.invocation.source = 'vendor' and $.invocation.event = 'work_item' and $.invocation.action in ['opened', 'reopened']" },
      target: "workflow:work-handler",
    })).toBe("Se origem é Vendor e evento é Work item e ação é Opened, Reopened, enviar para Work handler")
  })

  it("explains the explicit target rule without exposing JSONata", () => {
    expect(routingRuleDescription({
      id: "explicit",
      when: { expression: "$exists($.invocation.target)" },
      target: "$.invocation.target",
    })).toContain("respeitar esse workflow")
  })
})
