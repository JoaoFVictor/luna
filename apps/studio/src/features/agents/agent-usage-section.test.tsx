import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import type { AgentCatalogItem } from "@/api/types"
import { agentDefinitionView } from "@/features/agents/agent-definition-model"
import { AgentUsageSection } from "@/features/agents/agent-usage-section"

function catalogAgent(
  id: string,
  subagents: AgentCatalogItem["subagents"] = [],
): AgentCatalogItem {
  return {
    id,
    description: `${id} description`,
    mode: "read_only",
    model_profile: "default",
    output_schema_reference: "output.schema.json",
    output_schema: { type: "object" },
    skills: [],
    tools: [],
    mcp_servers: [],
    subagents,
    runtime_requirements: [],
    runtime_order: [],
    revision: `sha256:${"1".repeat(64)}`,
  }
}

describe("AgentUsageSection", () => {
  it("shows agents that consume the current agent as a subagent", () => {
    const agent = agentDefinitionView({
      id: "reviewer",
      description: "Reviews changes",
      model_profile: "default",
      mode: "read_only",
      instructions_file: "instructions.md",
      output_schema: "output.schema.json",
    })

    render(
      <MemoryRouter>
        <AgentUsageSection
          agent={agent}
          workflows={[]}
          agents={[
            catalogAgent("reviewer"),
            catalogAgent("orchestrator", [{ id: "reviewer", policy: { mode: "read_only" } }]),
            catalogAgent("unrelated", [{ id: "another" }]),
          ]}
          agentsCatalogStatus="complete"
          workflowsCatalogStatus="complete"
        />
      </MemoryRouter>,
    )

    expect(screen.getByText("orchestrator")).toBeTruthy()
    expect(screen.queryByText("unrelated")).toBeNull()
    expect(screen.getByRole("link", { name: /Inspecionar/u }).getAttribute("href"))
      .toBe("/agents?selected=orchestrator")
  })

  it("does not claim absence when either reverse-lookup catalog is partial", () => {
    const agent = agentDefinitionView({
      id: "reviewer",
      description: "Reviews changes",
      model_profile: "default",
      mode: "read_only",
      instructions_file: "instructions.md",
      output_schema: "output.schema.json",
    })

    render(
      <MemoryRouter>
        <AgentUsageSection
          agent={agent}
          workflows={[]}
          agents={[]}
          agentsCatalogStatus="partial"
          workflowsCatalogStatus="partial"
        />
      </MemoryRouter>,
    )

    expect(screen.getByText("Impacto incompleto: catálogo parcial")).toBeTruthy()
    expect(screen.getAllByText(/catálogo parcial impede afirmar que não há consumidor/u)).toHaveLength(2)
    expect(screen.queryByText("Nenhum workflow ativo referencia este agent.")).toBeNull()
    expect(screen.queryByText("Nenhum agent ativo usa este agent como subagent.")).toBeNull()
  })
})
