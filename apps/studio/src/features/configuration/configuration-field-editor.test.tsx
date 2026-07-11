import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { ConfigurationField } from "@/api/types"
import { ConfigurationFieldEditor } from "@/features/configuration/configuration-field-editor"

function field(
  path: readonly string[],
  overrides: Partial<ConfigurationField> = {},
): ConfigurationField {
  return {
    path: [...path],
    expression: `$.config.${path.join(".")}`,
    value_type: "string",
    exposure: "editable",
    required: true,
    present: true,
    value: "value",
    title: path.join(" / "),
    ...overrides,
  }
}

describe("ConfigurationFieldEditor", () => {
  it("uses collision-free control ids for structurally distinct paths", () => {
    render(
      <>
        <ConfigurationFieldEditor
          field={field(["a-b", "c"], { title: "First" })}
          canMutate
          pending={false}
          onSave={vi.fn()}
        />
        <ConfigurationFieldEditor
          field={field(["a", "b-c"], { title: "Second" })}
          canMutate
          pending={false}
          onSave={vi.fn()}
        />
      </>,
    )

    const first = screen.getByLabelText("First") as HTMLInputElement
    const second = screen.getByLabelText("Second") as HTMLInputElement
    expect(first.id).not.toBe(second.id)
    expect(first.id).not.toBe("")
    expect(second.id).not.toBe("")
  })

  it("does not turn an empty numeric input into zero", () => {
    const onSave = vi.fn()
    render(
      <ConfigurationFieldEditor
        field={field(["count"], {
          title: "Count",
          value_type: "integer",
          value: 5,
        })}
        canMutate
        pending={false}
        onSave={onSave}
      />,
    )

    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "" } })
    const save = screen.getByRole("button", { name: "Salvar campo" })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()
  })

  it("selects enum values by option index instead of string coercion", () => {
    const onSave = vi.fn()
    render(
      <ConfigurationFieldEditor
        field={field(["choice"], {
          title: "Choice",
          value: "1",
          enum_values: [1, "1"],
        })}
        canMutate
        pending={false}
        onSave={onSave}
      />,
    )

    const select = screen.getByLabelText("Choice") as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(["0", "1"])
    fireEvent.change(select, { target: { value: "0" } })
    expect(onSave).toHaveBeenLastCalledWith(["choice"], 1)
    fireEvent.change(select, { target: { value: "1" } })
    expect(onSave).toHaveBeenLastCalledWith(["choice"], "1")
  })
})
