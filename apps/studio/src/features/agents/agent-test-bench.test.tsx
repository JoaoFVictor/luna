import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type {
  StudioAgentTestPlan,
  StudioAgentTestResult,
  StudioAgentTestTarget,
} from "../../../../../src/studio/contracts/agent-test-bench.js"
import { AgentTestBench } from "./agent-test-bench"

const digest = (character: string) => `sha256:${character.repeat(64)}`
const token = "t".repeat(43)
const target: StudioAgentTestTarget = {
  kind: "installed",
  agent_id: "reviewer",
  revision: digest("1"),
}

const scope = {
  real_model_call: true as const,
  local_tools_executed: false as const,
  mcp_executed: false as const,
  subagents_executed: false as const,
  workflow_context_included: false as const,
  repository_context_included: false as const,
  agent_context_files_included: false as const,
  workflow_equivalent: false as const,
  statement: "Smoke isolado real; não é execução de workflow.",
}

function resolution() {
  return {
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
      model: "fixture/default",
      reasoning_effort: "medium" as const,
    },
    available_model_profiles: [
      {
        id: "alternate",
        provider: "fixture",
        model: "fixture/alternate",
        reasoning_effort: "high" as const,
      },
      {
        id: "default",
        model: "fixture/default",
        reasoning_effort: "medium" as const,
      },
    ],
    runtime: {
      id: "pi",
      display_name: "Pi agent runtime",
      supported_tool_protocols: ["local" as const],
      supported_runtime_requirements: ["tool_calling"],
      configuration_hash: digest("2"),
    },
    tools: [{
      id: "repository.read-file",
      protocol: "local" as const,
      execution: "excluded_no_isolation" as const,
      reason: "Sem isolamento comprovado.",
      runtime_requirements: ["tool_calling"],
      safety: {
        local_writes: false,
        network: false,
        external_side_effects: false,
      },
    }],
    mcp_servers: [{
      id: "demo-mcp",
      configured: true as const,
      runtime_supported: false,
      execution: "excluded_from_smoke" as const,
      reason: "Pi não materializa MCP.",
    }],
    subagents: [{
      id: "helper",
      declared_mode: "read_only" as const,
      execution: "excluded_from_smoke" as const,
      reason: "Subagent fora do smoke.",
    }],
    declared_skills: ["SKILL.md"],
    declared_agent_context_files: ["CONTEXT.md"],
    runtime_requirements: [{
      id: "tool_calling",
      sources: ["local_tool" as const],
      runtime_supported: true,
      required_for_smoke: false,
    }],
    blockers: [],
    catalog_fingerprint: digest("3"),
    output_schema_hash: digest("4"),
    instructions_hash: digest("5"),
    scope,
  }
}

const plan: StudioAgentTestPlan = {
  plan_id: `atp_${"p".repeat(32)}`,
  created_at: "2026-07-11T12:00:00.000Z",
  expires_at: "2099-07-11T12:05:00.000Z",
  snapshot_hash: digest("6"),
  fixture_hash: digest("7"),
  context_hash: digest("8"),
  resolution: resolution(),
  execution: {
    available: true,
    confirmation_required: true,
    confirmation_token: token,
  },
}

const result: StudioAgentTestResult = {
  plan_id: plan.plan_id,
  snapshot_hash: plan.snapshot_hash,
  completed_at: "2026-07-11T12:00:01.000Z",
  output: { status: "ok", summary: "bounded result" },
  output_schema_validated: true,
  usage: {
    input_tokens: 20,
    output_tokens: 4,
    total_tokens: 24,
    cost: { total: 0.0042, unit: "USD" },
  },
  scope,
}

describe("AgentTestBench", () => {
  it("plans, renders exclusions without leaking the token, and confirms one real call", async () => {
    const requestPlan = vi.fn().mockResolvedValue(plan)
    const execute = vi.fn().mockResolvedValue(result)
    render(
      <AgentTestBench
        target={target}
        initialFixture={{ task: "review" }}
        initialExplicitContext={{ policy: "explicit" }}
        plan={requestPlan}
        execute={execute}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Gerar preview efetivo" }))

    expect(await screen.findByText("Preview efetivo")).toBeDefined()
    expect(requestPlan).toHaveBeenCalledWith({
      target,
      fixture: { task: "review" },
      context: { kind: "json", value: { policy: "explicit" } },
    }, expect.any(AbortSignal))
    expect(document.body.textContent).not.toContain(token)
    expect(screen.getByText("repository.read-file")).toBeDefined()
    expect(screen.getByText("demo-mcp")).toBeDefined()
    expect(screen.getByText("helper")).toBeDefined()
    expect(screen.getByText(/Skills: SKILL.md/)).toBeDefined()

    const executeButton = screen.getByRole("button", { name: "Executar smoke real" })
    expect((executeButton as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText("Confirmo uma chamada real ao modelo"))
    fireEvent.click(screen.getByLabelText("Confirmo o escopo isolado do smoke"))
    expect((executeButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(executeButton)

    await waitFor(() => expect(execute).toHaveBeenCalledWith(
      plan.plan_id,
      {
        confirmation_token: token,
        confirmation: {
          kind: "local_explicit",
          real_model_call_confirmed: true,
          isolated_smoke_scope_confirmed: true,
        },
      },
      expect.any(AbortSignal),
    ))
    expect(await screen.findByText("Resultado validado")).toBeDefined()
    expect(screen.getByText(/bounded result/)).toBeDefined()
    expect(screen.getByText("0.0042 USD")).toBeDefined()
    expect(document.body.textContent).not.toContain(token)
    expect((screen.getByRole("button", { name: "Executar smoke real" }) as HTMLButtonElement).disabled)
      .toBe(true)
  })

  it("rejects invalid fixture JSON before calling the backend", async () => {
    const requestPlan = vi.fn().mockResolvedValue(plan)
    render(
      <AgentTestBench
        target={target}
        plan={requestPlan}
        execute={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText("Fixture JSON"), {
      target: { value: "[not-an-object]" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Gerar preview efetivo" }))

    expect(await screen.findByText("Fixture precisa ser JSON válido.")).toBeDefined()
    expect(requestPlan).not.toHaveBeenCalled()
  })

  it("invalidates a preview as soon as fixture input changes", async () => {
    render(
      <AgentTestBench
        target={target}
        plan={vi.fn().mockResolvedValue(plan)}
        execute={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Gerar preview efetivo" }))
    expect(await screen.findByText("Preview efetivo")).toBeDefined()

    fireEvent.change(screen.getByLabelText("Fixture JSON"), {
      target: { value: '{"changed":true}' },
    })

    await waitFor(() => expect(screen.queryByText("Preview efetivo")).toBeNull())
    expect(screen.queryByLabelText("Confirmo uma chamada real ao modelo")).toBeNull()
  })

  it("replans when a loaded model profile is selected", async () => {
    const alternatePlan: StudioAgentTestPlan = {
      ...plan,
      plan_id: `atp_${"a".repeat(32)}`,
      resolution: {
        ...plan.resolution,
        selected_model_profile: plan.resolution.available_model_profiles[0]!,
      },
    }
    const requestPlan = vi.fn()
      .mockResolvedValueOnce(plan)
      .mockResolvedValueOnce(alternatePlan)
    render(
      <AgentTestBench
        target={target}
        plan={requestPlan}
        execute={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Gerar preview efetivo" }))
    expect(await screen.findByText("Preview efetivo")).toBeDefined()

    fireEvent.change(screen.getByLabelText("Model profile"), {
      target: { value: "alternate" },
    })
    expect(screen.queryByText("Preview efetivo")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Gerar preview efetivo" }))

    await waitFor(() => expect(requestPlan).toHaveBeenLastCalledWith(
      expect.objectContaining({ model_profile_id: "alternate" }),
      expect.any(AbortSignal),
    ))
    expect(await screen.findByText("alternate")).toBeDefined()
  })

  it("renders backend blockers without any execution confirmation", async () => {
    const blocker = {
      code: "trusted_write_requires_isolation" as const,
      message: "Trusted write exige isolamento comprovado.",
    }
    const blocked: StudioAgentTestPlan = {
      ...plan,
      resolution: {
        ...plan.resolution,
        agent_mode: "trusted_local_write",
        blockers: [blocker],
      },
      execution: { available: false, blockers: [blocker] },
    }
    render(
      <AgentTestBench
        target={target}
        plan={vi.fn().mockResolvedValue(blocked)}
        execute={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Gerar preview efetivo" }))

    expect(await screen.findByText("Execução bloqueada")).toBeDefined()
    expect(screen.getByText(/Trusted write exige isolamento comprovado/)).toBeDefined()
    expect(screen.queryByLabelText("Confirmo uma chamada real ao modelo")).toBeNull()
    expect(document.body.textContent).not.toContain(token)
  })

  it("fails closed if authority is removed after a preview was generated", async () => {
    const execute = vi.fn()
    const props = {
      target,
      plan: vi.fn().mockResolvedValue(plan),
      execute,
    }
    const view = render(<AgentTestBench {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Gerar preview efetivo" }))
    expect(await screen.findByText("Preview efetivo")).toBeDefined()
    fireEvent.click(screen.getByLabelText("Confirmo uma chamada real ao modelo"))
    fireEvent.click(screen.getByLabelText("Confirmo o escopo isolado do smoke"))

    view.rerender(<AgentTestBench {...props} disabled />)

    expect((screen.getByRole("button", { name: "Executar smoke real" }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect((screen.getByLabelText("Confirmo uma chamada real ao modelo") as HTMLInputElement).disabled)
      .toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })
})
