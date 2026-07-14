import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { CapabilityCatalog, CapabilityRegistration, JsonValue, WorkflowSummary } from "@/api/types"
import { WorkflowNodeAdd } from "@/features/workflows/workflow-node-add"
import { filterWorkflowPaletteItems } from "@/features/workflows/workflow-node-catalog"
import { workflowSourceNodes } from "@/features/workflows/workflow-source-model"

const common = {
  owner: { capability_id: "test", capability_version: "1", capability_kind: "execution" as const },
  input_schema: {},
  output_schema: {},
  required_ports: [],
  requires_repository: false,
}

const registrations: CapabilityRegistration[] = [
  {
    ...common,
    registration_kind: "built_in",
    id: "reports.final_report",
    presentation: { title: "Gerar relatório final", category: "Resultados" },
    deferred_lifecycle: "final_report",
  },
  {
    ...common,
    registration_kind: "built_in",
    id: "task-context.collect",
    presentation: { title: "Coletar dados da tarefa", category: "Contexto" },
  },
]

const library: CapabilityCatalog = {
  technical_fingerprint: `sha256:${"1".repeat(64)}`,
  presentation_fingerprint: `sha256:${"2".repeat(64)}`,
  capabilities: [],
  registrations,
}

function workflow(
  id: string,
  options: Partial<Pick<WorkflowSummary, "mode" | "synchronous_composition" | "synchronous_composition_blocked_reason" | "node_counts">> = {},
): WorkflowSummary {
  return {
    id,
    mode: options.mode ?? "read_only",
    revision: `sha256:${"3".repeat(64)}`,
    capabilities: [],
    registrations: [],
    agents: [],
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: { type: "object" },
    synchronous_composition: options.synchronous_composition ?? "allowed",
    ...(options.synchronous_composition_blocked_reason === undefined
      ? {}
      : { synchronous_composition_blocked_reason: options.synchronous_composition_blocked_reason }),
    node_counts: options.node_counts ?? {
      built_in: 0,
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

describe("WorkflowNodeAdd", () => {
  it("searches instantly without requiring accents and adds the sole result with Enter", () => {
    const onOperations = vi.fn()
    render(
      <WorkflowNodeAdd
        source={{ nodes: [] }}
        nodes={[]}
        library={library}
        agents={[]}
        canMutate
        pending={false}
        open
        onOperations={onOperations}
      />,
    )

    const search = screen.getByRole("textbox", { name: "Buscar passos" })
    fireEvent.change(search, { target: { value: "relatorio" } })

    expect(screen.getByText("1 passo encontrado · Enter para adicionar")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Gerar relatório final/u })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Coletar dados da tarefa/u })).toBeNull()

    fireEvent.keyDown(search, { key: "Enter" })
    expect(onOperations).toHaveBeenCalledOnce()
  })

  it("matches technical ids and tags through the same canonical filter", () => {
    const items = [{
      id: "reports.final_report",
      kind: "built_in" as const,
      title: "Gerar relatório final",
      summary: "Entrega o resultado",
      category: "Resultados",
      tags: ["saída"],
      hasExternalEffect: false,
      requiresRepository: false,
    }]

    expect(filterWorkflowPaletteItems(items, "final_report")).toEqual(items)
    expect(filterWorkflowPaletteItems(items, "saida")).toEqual(items)
  })

  it("shows safe nested workflows but filters blocked HITL and mode escalation", () => {
    render(
      <WorkflowNodeAdd
        source={{ mode: "read_only", nodes: [] }}
        nodes={[]}
        library={library}
        agents={[]}
        workflows={[
          workflow("nested-safe", {
            node_counts: { built_in: 0, agent: 0, pattern: 0, human_gate: 0, workflow: 1, loop: 0 },
          }),
          workflow("approval", {
            synchronous_composition: "blocked",
            synchronous_composition_blocked_reason: "human_input",
            node_counts: { built_in: 0, agent: 0, pattern: 0, human_gate: 1, workflow: 0, loop: 0 },
          }),
          workflow("writer", { mode: "trusted_local_write" }),
        ]}
        canMutate
        pending={false}
        open
        onOperations={vi.fn()}
      />,
    )

    const search = screen.getByRole("textbox", { name: "Buscar passos" })
    fireEvent.change(search, { target: { value: "nested-safe" } })
    expect(screen.getByRole("button", { name: /Nested safe/u })).toBeTruthy()
    fireEvent.change(search, { target: { value: "approval" } })
    expect(screen.getByText("Nenhum passo encontrado")).toBeTruthy()
    fireEvent.change(search, { target: { value: "writer" } })
    expect(screen.getByText("Nenhum passo encontrado")).toBeTruthy()
  })

  it("explains and disables a normal step after a deferred final result", () => {
    const source: JsonValue = {
      nodes: [{ id: "final", type: "built_in", uses: "reports.final_report" }],
    }
    render(
      <WorkflowNodeAdd
        source={source}
        nodes={workflowSourceNodes(source)}
        library={library}
        agents={[]}
        canMutate
        pending={false}
        afterNodeId="final"
        open
        onOperations={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: /Coletar dados da tarefa/u })).toHaveProperty("disabled", true)
    expect(screen.getByText(/deve ficar depois das etapas normais/u)).toBeTruthy()
  })

  it("explains an actual bifurcation and adds a normal YAML dependency", () => {
    const source: JsonValue = {
      capabilities: ["test"],
      nodes: [
        { id: "source", type: "built_in", uses: "task-context.collect" },
        { id: "existing", type: "built_in", uses: "task-context.collect", after: ["source"] },
      ],
    }
    const onOperations = vi.fn()
    render(
      <WorkflowNodeAdd
        source={source}
        nodes={workflowSourceNodes(source)}
        library={library}
        agents={[]}
        canMutate
        pending={false}
        afterNodeId="source"
        open
        onOperations={onOperations}
      />,
    )

    expect(screen.getByText("Adicionar ramo a partir de Coletar dados da tarefa")).toBeDefined()
    expect(screen.getByText(/poderá executar em paralelo com os outros caminhos/u)).toBeDefined()
    expect(screen.getByText(/nenhum tipo especial de branch será escondido no YAML/u)).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: /Coletar dados da tarefa/u }))

    expect(onOperations).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        op: "sequence_insert",
        path: ["nodes"],
        value: expect.objectContaining({ after: ["source"] }),
      }),
    ]))
  })
})
