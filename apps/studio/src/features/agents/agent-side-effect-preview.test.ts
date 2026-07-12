import { describe, expect, it } from "vitest"

import { agentSideEffectPreview } from "@/features/agents/agent-side-effect-preview"

describe("agent side-effect preview", () => {
  it("treats trusted_local_write as an unknown potential write", () => {
    expect(agentSideEffectPreview({ mode: "trusted_local_write" }, "writer"))
      .toEqual([
        expect.objectContaining({
          nodeId: "writer",
          semantics: "unknown",
        }),
      ])
  })

  it("never interprets unavailable authority as no effects", () => {
    expect(agentSideEffectPreview(undefined, "reviewer"))
      .toEqual([
        expect.objectContaining({
          nodeId: "reviewer",
          semantics: "unknown",
        }),
      ])
  })
})
