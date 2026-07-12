import { describe, expect, it } from "vitest"

import {
  buildRunPlanInput,
  DEFAULT_INVOCATION_JSON,
} from "@/features/launch/launch-input"

describe("buildRunPlanInput", () => {
  it("builds both canonical public variants with an explicit execution scope", () => {
    const adapter = buildRunPlanInput({
      mode: "adapter",
      adapterId: "task-url",
      opaqueInput: "opaque://task/42",
      invocationJson: DEFAULT_INVOCATION_JSON,
      acknowledgedAdapterEffects: ["network_read"],
    })
    const invocation = buildRunPlanInput({
      mode: "invocation",
      adapterId: "ignored",
      opaqueInput: "ignored",
      invocationJson: DEFAULT_INVOCATION_JSON,
      acknowledgedAdapterEffects: [],
    })

    expect(adapter).toEqual({
      success: true,
      input: {
        kind: "adapter",
        definition_source: { kind: "installed" },
        execution_scope: { kind: "workflow" },
        adapter_id: "task-url",
        input: { kind: "cli", value: "opaque://task/42" },
        acknowledged_effects: ["network_read"],
      },
    })
    expect(invocation).toMatchObject({
      success: true,
      input: {
        kind: "invocation",
        definition_source: { kind: "installed" },
        execution_scope: { kind: "workflow" },
        invocation: { version: "2026-06", source: "studio", event: "manual" },
      },
    })
    expect(JSON.stringify({ adapter, invocation })).not.toContain("actor_binding")
    expect(JSON.stringify({ adapter, invocation })).not.toContain("workflow_id")
    expect(JSON.stringify({ adapter, invocation })).not.toContain("config_hash")
  })

  it("rejects invalid JSON and unknown invocation fields", () => {
    expect(buildRunPlanInput({
      mode: "invocation",
      adapterId: "ignored",
      opaqueInput: "ignored",
      invocationJson: "{not-json",
      acknowledgedAdapterEffects: [],
    })).toMatchObject({ success: false })

    expect(buildRunPlanInput({
      mode: "invocation",
      adapterId: "ignored",
      opaqueInput: "ignored",
      invocationJson: JSON.stringify({
        version: "2026-06",
        source: "studio",
        event: "manual",
        workflow_id: "browser-forged",
      }),
      acknowledgedAdapterEffects: [],
    })).toMatchObject({ success: false })
  })
})
