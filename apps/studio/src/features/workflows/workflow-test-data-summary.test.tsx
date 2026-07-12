import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  workflowTestDataShape,
  WorkflowTestDataSummary,
} from "@/features/workflows/workflow-test-data-summary"

describe("WorkflowTestDataSummary", () => {
  it("describes objects, arrays, and primitive values without expanding JSON", () => {
    expect(workflowTestDataShape({ input: 1 })).toEqual({ label: "1 campo", fields: ["input"] })
    expect(workflowTestDataShape([1, 2])).toEqual({ label: "2 itens", fields: [] })
    expect(workflowTestDataShape("ok")).toEqual({ label: "Valor de texto", fields: [] })

    render(<WorkflowTestDataSummary name="sample" value={{ one: 1, two: 2 }} />)
    expect(screen.getByText("2 campos")).toBeTruthy()
    expect(screen.getByText("Ver JSON técnico").closest("details")?.open).toBe(false)
    expect(screen.getByLabelText("JSON dos dados sample")).toBeTruthy()
  })
})
