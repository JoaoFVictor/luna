import type { PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { studioApi } from "@/api/client"
import { WorkflowExpressionFixtureEditor } from "@/features/workflows/workflow-expression-fixture-editor"

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

afterEach(() => vi.restoreAllMocks())

describe("WorkflowExpressionFixtureEditor", () => {
  it("follows the globally active fixture and promotes dropdown selection", () => {
    const queryClient = new QueryClient()
    const onSelect = vi.fn()
    const view = render(
      <WorkflowExpressionFixtureEditor
        fieldName="payload"
        expression="$.invocation"
        fixtures={{ first: { invocation: 1 }, second: { invocation: 2 } }}
        activeFixtureName="second"
        disabled={false}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onSelect={onSelect}
      />,
      { wrapper: wrapper(queryClient) },
    )

    expect((screen.getByRole("combobox", { name: "Fixture salva" }) as HTMLSelectElement).value)
      .toBe("second")
    fireEvent.change(screen.getByRole("combobox", { name: "Fixture salva" }), {
      target: { value: "first" },
    })
    expect(onSelect).toHaveBeenCalledWith("first")

    view.rerender(
      <WorkflowExpressionFixtureEditor
        fieldName="payload"
        expression="$.invocation"
        fixtures={{ first: { invocation: 1 }, second: { invocation: 2 } }}
        activeFixtureName="second"
        disabled={false}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onSelect={onSelect}
      />,
    )
    expect((screen.getByRole("combobox", { name: "Fixture salva" }) as HTMLSelectElement).value)
      .toBe("second")
  })

  it("loads a saved fixture, previews it through the isolated API, and saves a named copy", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const evaluate = vi.spyOn(studioApi, "evaluateExpression").mockResolvedValue({
      status: "evaluated",
      result: { kind: "json", value: 42 },
      diagnostics: [],
    })
    const onSave = vi.fn()

    render(
      <WorkflowExpressionFixtureEditor
        fieldName="payload"
        expression="$.invocation.issue"
        fixtures={{ default: { invocation: { issue: 1 } } }}
        disabled={false}
        onSave={onSave}
        onRemove={vi.fn()}
      />,
      { wrapper: wrapper(queryClient) },
    )

    const fixture = screen.getByRole("textbox", {
      name: "Fixture para preview — payload",
    }) as HTMLTextAreaElement
    expect(JSON.parse(fixture.value)).toEqual({ invocation: { issue: 1 } })

    fireEvent.click(screen.getByRole("button", { name: "Preview seguro" }))
    await waitFor(() => expect(evaluate).toHaveBeenCalledWith({
      expression: "$.invocation.issue",
      fixture: { invocation: { issue: 1 } },
    }))
    expect(await screen.findByText("42")).toBeDefined()

    fireEvent.change(screen.getByRole("textbox", { name: "Nome da fixture" }), {
      target: { value: "issue 42" },
    })
    fireEvent.change(fixture, {
      target: { value: JSON.stringify({ invocation: { issue: 42 } }) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Salvar no draft" }))
    expect(onSave).toHaveBeenCalledWith("issue 42", {
      invocation: { issue: 42 },
    })
  })

  it("deletes only an explicitly selected saved fixture", () => {
    const queryClient = new QueryClient()
    const onRemove = vi.fn()
    render(
      <WorkflowExpressionFixtureEditor
        fieldName="payload"
        expression="$.invocation"
        fixtures={{ first: { invocation: 1 }, second: { invocation: 2 } }}
        disabled={false}
        onSave={vi.fn()}
        onRemove={onRemove}
      />,
      { wrapper: wrapper(queryClient) },
    )

    fireEvent.change(screen.getByRole("combobox", { name: "Fixture salva" }), {
      target: { value: "second" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Excluir fixture" }))
    expect(onRemove).toHaveBeenCalledWith("second")
  })

  it("rejects an oversized preview locally before calling the API", () => {
    const queryClient = new QueryClient()
    const evaluate = vi.spyOn(studioApi, "evaluateExpression")
    render(
      <WorkflowExpressionFixtureEditor
        fieldName="payload"
        expression="$.invocation"
        fixtures={{}}
        disabled={false}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
      { wrapper: wrapper(queryClient) },
    )

    fireEvent.change(
      screen.getByRole("textbox", { name: "Fixture para preview — payload" }),
      { target: { value: JSON.stringify({ value: "x".repeat(130 * 1_024) }) } },
    )
    fireEvent.click(screen.getByRole("button", { name: "Preview seguro" }))
    expect(evaluate).not.toHaveBeenCalled()
    expect(screen.getByText(/byte|131072/ui)).toBeDefined()
  })
})
