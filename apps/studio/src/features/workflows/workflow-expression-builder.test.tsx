import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

import { WorkflowExpressionBuilder } from "@/features/workflows/workflow-expression-builder"
import { workflowSourceNodes } from "@/features/workflows/workflow-source-model"
import type { JsonValue } from "@/api/types"
import { WORKFLOW_FIELD_DRAG_MIME } from "@/features/workflows/workflow-field-drag"

class TestDataTransfer {
  readonly #values = new Map<string, string>()
  dropEffect = "none"
  effectAllowed = "uninitialized"

  get types(): string[] {
    return [...this.#values.keys()]
  }

  setData(type: string, value: string) {
    this.#values.set(type, value)
  }

  getData(type: string): string {
    return this.#values.get(type) ?? ""
  }
}

function renderBuilder(value: JsonValue, valueType: string) {
  const node = workflowSourceNodes({
    nodes: [{
      id: "report",
      type: "built_in",
      uses: "reports.final_report",
      input: { field_name: value },
    }],
  })[0]
  if (node === undefined) throw new Error("fixture node missing")
  const onOperations = vi.fn()
  render(
    <WorkflowExpressionBuilder
      node={node}
      nodes={[node]}
      canMutate
      pending={false}
      onOperations={onOperations}
      fixtures={{}}
      onSaveFixture={vi.fn()}
      onRemoveFixture={vi.fn()}
      suggestedFields={[{ path: ["field_name"], valueType }]}
    />,
  )
  return onOperations
}

describe("WorkflowExpressionBuilder", () => {
  it("edits a string as a normal text field instead of JSON", () => {
    const onOperations = renderBuilder("old", "string")

    fireEvent.change(screen.getByRole("textbox", { name: "Valor de Field name" }), {
      target: { value: "Relatório final" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Salvar campo" }))

    expect(onOperations).toHaveBeenCalledWith([{
      op: "set",
      path: ["nodes", 0, "input"],
      value: { field_name: "Relatório final" },
    }])
    expect(screen.queryByText("Literal JSON")).toBeNull()
  })

  it("edits an integer with a numeric control", () => {
    const onOperations = renderBuilder(1, "integer")

    fireEvent.change(screen.getByRole("spinbutton", { name: "Valor de Field name" }), {
      target: { value: "42" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Salvar campo" }))

    expect(onOperations).toHaveBeenCalledWith([{
      op: "set",
      path: ["nodes", 0, "input"],
      value: { field_name: 42 },
    }])
  })

  it("maps a compatible field from a previous step through the searchable picker", () => {
    const nodes = workflowSourceNodes({
      nodes: [
        { id: "context", type: "built_in", uses: "context.collect_context" },
        {
          id: "report",
          type: "built_in",
          uses: "reports.final_report",
          after: ["context"],
          input: { title: { expression: "$.invocation" } },
        },
      ],
    })
    const node = nodes[1]
    if (node === undefined) throw new Error("report node missing")
    const onOperations = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkflowExpressionBuilder
          node={node}
          nodes={nodes}
          canMutate
          pending={false}
          onOperations={onOperations}
          fixtures={{}}
          onSaveFixture={vi.fn()}
          onRemoveFixture={vi.fn()}
          suggestedFields={[{ path: ["title"], valueType: "string" }]}
          availableSourceFields={new Map([
            ["context", [{ path: ["repository", "root"], valueType: "string" }]],
          ])}
        />
      </QueryClientProvider>,
    )

    fireEvent.change(screen.getByRole("textbox", { name: "Buscar dados anteriores" }), {
      target: { value: "repository.root" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Usar context › repository.root" }))

    expect(onOperations).toHaveBeenCalledWith([{
      op: "set",
      path: ["nodes", 1, "input"],
      value: { title: { expression: "$.steps.context.repository.root" } },
    }])
  })

  it("drags an available output directly onto another node parameter", () => {
    const nodes = workflowSourceNodes({
      nodes: [
        { id: "context", type: "built_in", uses: "context.collect_context" },
        {
          id: "report",
          type: "built_in",
          uses: "reports.final_report",
          after: ["context"],
          input: {
            source: { expression: "$.invocation" },
            title: "Relatório",
          },
        },
      ],
    })
    const node = nodes[1]
    if (node === undefined) throw new Error("report node missing")
    const onOperations = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkflowExpressionBuilder
          node={node}
          nodes={nodes}
          canMutate
          pending={false}
          onOperations={onOperations}
          fixtures={{}}
          onSaveFixture={vi.fn()}
          onRemoveFixture={vi.fn()}
          suggestedFields={[
            { path: ["source"], valueType: "string" },
            { path: ["title"], valueType: "string" },
          ]}
          availableSourceFields={new Map([
            ["context", [{ path: ["repository", "root"], valueType: "string" }]],
          ])}
        />
      </QueryClientProvider>,
    )

    const dataTransfer = new TestDataTransfer()
    const source = screen.getByRole("button", { name: "Usar context › repository.root" })
    const target = screen.getByRole("group", { name: "Parâmetro Title" })
    fireEvent.dragStart(source, { dataTransfer })
    expect(dataTransfer.types).toContain(WORKFLOW_FIELD_DRAG_MIME)
    fireEvent.dragEnter(target, { dataTransfer })
    fireEvent.drop(target, { dataTransfer })

    expect(onOperations).toHaveBeenCalledWith([{
      op: "set",
      path: ["nodes", 1, "input"],
      value: {
        source: { expression: "$.invocation" },
        title: { expression: "$.steps.context.repository.root" },
      },
    }])
  })

  it("rejects a drop when the source and destination schema types differ", () => {
    const nodes = workflowSourceNodes({
      nodes: [
        { id: "context", type: "built_in", uses: "context.collect_context" },
        {
          id: "report",
          type: "built_in",
          uses: "reports.final_report",
          after: ["context"],
          input: {
            source: { expression: "$.invocation" },
            attempts: 1,
          },
        },
      ],
    })
    const node = nodes[1]
    if (node === undefined) throw new Error("report node missing")
    const onOperations = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkflowExpressionBuilder
          node={node}
          nodes={nodes}
          canMutate
          pending={false}
          onOperations={onOperations}
          fixtures={{}}
          onSaveFixture={vi.fn()}
          onRemoveFixture={vi.fn()}
          suggestedFields={[
            { path: ["source"], valueType: "string" },
            { path: ["attempts"], valueType: "integer" },
          ]}
          availableSourceFields={new Map([
            ["context", [{ path: ["repository", "root"], valueType: "string" }]],
          ])}
        />
      </QueryClientProvider>,
    )

    const dataTransfer = new TestDataTransfer()
    fireEvent.dragStart(
      screen.getByRole("button", { name: "Usar context › repository.root" }),
      { dataTransfer },
    )
    fireEvent.drop(screen.getByRole("group", { name: "Parâmetro Attempts" }), {
      dataTransfer,
    })

    expect(onOperations).not.toHaveBeenCalled()
    expect(screen.getByText("Este dado não é compatível com o parâmetro de destino.")).toBeTruthy()
  })

  it("materializes and edits a nested suggested input as nested objects", () => {
    const node = workflowSourceNodes({
      nodes: [{
        id: "report",
        type: "built_in",
        uses: "reports.final_report",
        input: { config: { title: "old" } },
      }],
    })[0]
    if (node === undefined) throw new Error("report node missing")
    const onOperations = vi.fn()
    render(
      <WorkflowExpressionBuilder
        node={node}
        nodes={[node]}
        canMutate
        pending={false}
        onOperations={onOperations}
        fixtures={{}}
        onSaveFixture={vi.fn()}
        onRemoveFixture={vi.fn()}
        suggestedFields={[
          { path: ["config"], valueType: "object" },
          { path: ["config", "title"], valueType: "string" },
          { path: ["config", "retries"], valueType: "integer" },
        ]}
      />,
    )

    fireEvent.change(screen.getByRole("textbox", { name: "Valor de Title" }), {
      target: { value: "new" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Salvar campo" }))
    expect(onOperations).toHaveBeenCalledWith([{
      op: "set",
      path: ["nodes", 0, "input"],
      value: { config: { title: "new" } },
    }])

    fireEvent.click(screen.getByRole("button", { name: /config\.retries · integer/i }))
    expect(onOperations).toHaveBeenCalledWith([{
      op: "set",
      path: ["nodes", 0, "input"],
      value: { config: { title: "old", retries: 0 } },
    }])
  })

  it("drags a literal dotted output from a hyphenated node into a nested input", () => {
    const nodes = workflowSourceNodes({
      nodes: [
        { id: "context-data", type: "built_in", uses: "context.collect_context" },
        {
          id: "report",
          type: "built_in",
          uses: "reports.final_report",
          after: ["context-data"],
          input: {
            source: { expression: "$.invocation" },
            config: { title: "Relatório" },
          },
        },
      ],
    })
    const node = nodes[1]
    if (node === undefined) throw new Error("report node missing")
    const onOperations = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkflowExpressionBuilder
          node={node}
          nodes={nodes}
          canMutate
          pending={false}
          onOperations={onOperations}
          fixtures={{}}
          onSaveFixture={vi.fn()}
          onRemoveFixture={vi.fn()}
          suggestedFields={[
            { path: ["source"], valueType: "string" },
            { path: ["config", "title"], valueType: "string" },
          ]}
          availableSourceFields={new Map([
            ["context-data", [{ path: ["literal.dot"], valueType: "string" }]],
          ])}
        />
      </QueryClientProvider>,
    )

    const dataTransfer = new TestDataTransfer()
    fireEvent.dragStart(
      screen.getByRole("button", { name: 'Usar context-data › ["literal.dot"]' }),
      { dataTransfer },
    )
    fireEvent.drop(screen.getByRole("group", { name: "Parâmetro Title" }), {
      dataTransfer,
    })

    expect(onOperations).toHaveBeenCalledWith([{
      op: "set",
      path: ["nodes", 1, "input"],
      value: {
        source: { expression: "$.invocation" },
        config: {
          title: { expression: '$.steps["context-data"]["literal.dot"]' },
        },
      },
    }])
  })
})
