import { afterEach, describe, expect, it, vi } from "vitest"

import { StudioAgentTestBenchApi } from "@/api/agent-test-bench"
import { StudioApiClient } from "@/api/client"

const digest = (character: string) => `sha256:${character.repeat(64)}`
const planId = `atp_${"p".repeat(32)}`
const token = "t".repeat(48)

const validSession = {
  csrf_token: "csrf-token",
  expires_at: "2026-07-11T13:00:00.000Z",
  principal: { id: "local-user", authentication: "local-session" },
  mode: "local-single-user",
} as const

const scope = {
  real_model_call: true as const,
  local_tools_executed: false as const,
  mcp_executed: false as const,
  subagents_executed: false as const,
  workflow_context_included: false as const,
  repository_context_included: false as const,
  agent_context_files_included: false as const,
  workflow_equivalent: false as const,
  statement: "Isolated smoke test; not a workflow execution.",
}

const resolution = {
  target: {
    kind: "installed" as const,
    agent_id: "reviewer",
    agent_revision: digest("1"),
    requested_revision: digest("1"),
  },
  agent_mode: "read_only" as const,
  default_model_profile_id: "default",
  selected_model_profile: {
    id: "default",
    provider: "fixture",
    model: "fixture/model",
    reasoning_effort: "medium" as const,
  },
  available_model_profiles: [{
    id: "default",
    provider: "fixture",
    model: "fixture/model",
    reasoning_effort: "medium" as const,
  }],
  runtime: {
    id: "runtime",
    display_name: "Runtime",
    supported_tool_protocols: ["local" as const],
    supported_runtime_requirements: [],
    configuration_hash: digest("2"),
  },
  tools: [],
  mcp_servers: [],
  subagents: [],
  declared_skills: [],
  declared_agent_context_files: [],
  runtime_requirements: [],
  blockers: [],
  catalog_fingerprint: digest("3"),
  output_schema_hash: digest("4"),
  instructions_hash: digest("5"),
  scope,
}

const plan = {
  plan_id: planId,
  created_at: "2026-07-11T12:00:00.000Z",
  expires_at: "2026-07-11T12:05:00.000Z",
  snapshot_hash: digest("6"),
  fixture_hash: digest("7"),
  context_hash: digest("8"),
  resolution,
  execution: {
    available: true as const,
    confirmation_required: true as const,
    confirmation_token: token,
  },
}

const result = {
  plan_id: planId,
  snapshot_hash: digest("6"),
  completed_at: "2026-07-11T12:00:01.000Z",
  output: { status: "ok" },
  output_schema_validated: true as const,
  usage: {
    input_tokens: 7,
    output_tokens: 3,
    total_tokens: 10,
    cost: { total: 0.001, unit: "USD" },
  },
  scope,
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

afterEach(() => {
  window.history.replaceState(null, "", "/")
  vi.unstubAllGlobals()
})

describe("StudioAgentTestBenchApi", () => {
  it("sends only canonical plan and one-shot execution inputs", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(validSession))
      .mockResolvedValueOnce(json(plan))
      .mockResolvedValueOnce(json(result))
    vi.stubGlobal("fetch", fetchMock)
    const client = new StudioApiClient()
    const api = new StudioAgentTestBenchApi(client)
    await client.bootstrap()

    const planned = await api.plan({
      target: {
        kind: "installed",
        agent_id: "reviewer",
        revision: digest("1"),
      },
      fixture: { task: "review" },
      context: { kind: "json", value: { policy: "explicit-only" } },
    })
    const executed = await api.execute(planned.plan_id, {
      confirmation_token: planned.execution.available
        ? planned.execution.confirmation_token
        : token,
      confirmation: {
        kind: "local_explicit",
        real_model_call_confirmed: true,
        isolated_smoke_scope_confirmed: true,
      },
    })

    expect(executed.output).toEqual({ status: "ok" })
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/studio/v1/agent-test-plans",
    )
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      target: {
        kind: "installed",
        agent_id: "reviewer",
        revision: digest("1"),
      },
      fixture: { task: "review" },
      context: { kind: "json", value: { policy: "explicit-only" } },
    })
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/studio/v1/agent-test-plans/${planId}/execute`,
    )
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({
      confirmation_token: token,
      confirmation: {
        kind: "local_explicit",
        real_model_call_confirmed: true,
        isolated_smoke_scope_confirmed: true,
      },
    }))
  })

  it("rejects browser-forged plan fields before sending", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(validSession))
    vi.stubGlobal("fetch", fetchMock)
    const client = new StudioApiClient()
    const api = new StudioAgentTestBenchApi(client)
    await client.bootstrap()

    expect(() => api.plan({
      target: {
        kind: "installed",
        agent_id: "reviewer",
        revision: digest("1"),
      },
      fixture: {},
      context: { kind: "none" },
      repository_context: { root: "/private" },
    } as never)).toThrow()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("rejects a successful execution response outside the canonical schema", async () => {
    window.history.replaceState(null, "", "/#capability=launch-token")
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(validSession))
      .mockResolvedValueOnce(json({ ...result, output_schema_validated: false }))
    vi.stubGlobal("fetch", fetchMock)
    const client = new StudioApiClient()
    const api = new StudioAgentTestBenchApi(client)
    await client.bootstrap()

    await expect(api.execute(planId, {
      confirmation_token: token,
      confirmation: {
        kind: "local_explicit",
        real_model_call_confirmed: true,
        isolated_smoke_scope_confirmed: true,
      },
    })).rejects.toMatchObject({
      code: "studio_response_invalid",
      status: 200,
    })
  })
})
