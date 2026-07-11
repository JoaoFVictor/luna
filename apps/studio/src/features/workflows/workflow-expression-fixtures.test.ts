import { describe, expect, it } from "vitest"

import type { JsonValue } from "@/api/types"
import {
  WORKFLOW_EXPRESSION_FIXTURE_LIMITS,
  withoutWorkflowExpressionFixture,
  withWorkflowExpressionFixture,
  workflowExpressionFixtures,
} from "@/features/workflows/workflow-expression-fixtures"

describe("workflow expression fixture sidecar", () => {
  it("preserves unrelated layout data while adding, replacing, and removing fixtures", () => {
    const initial = {
      workflow: {
        positions: { node: { x: 10, y: 20 } },
        expression_fixtures: { default: { invocation: { issue: 1 } } },
      },
      future_extension: true,
    }

    const added = withWorkflowExpressionFixture(
      initial,
      "pull request",
      { invocation: { issue: 42 } },
    )
    expect(workflowExpressionFixtures(added)).toEqual({
      default: { invocation: { issue: 1 } },
      "pull request": { invocation: { issue: 42 } },
    })
    expect(added).toMatchObject({
      workflow: { positions: { node: { x: 10, y: 20 } } },
      future_extension: true,
    })

    const replaced = withWorkflowExpressionFixture(
      added,
      "default",
      { invocation: { issue: 2 } },
    )
    expect(workflowExpressionFixtures(replaced).default).toEqual({
      invocation: { issue: 2 },
    })

    const removed = withoutWorkflowExpressionFixture(replaced, "pull request")
    expect(workflowExpressionFixtures(removed)).toEqual({
      default: { invocation: { issue: 2 } },
    })
  })

  it("rejects unsafe names and a fixture count above the bounded sidecar contract", () => {
    expect(() => withWorkflowExpressionFixture({}, "__proto__", {})).toThrow(
      /nome da fixture/u,
    )

    let layout: JsonValue = {}
    for (let index = 0; index < WORKFLOW_EXPRESSION_FIXTURE_LIMITS.maxFixtures; index += 1) {
      layout = withWorkflowExpressionFixture(layout, `fixture-${index}`, { index })
    }
    expect(() => withWorkflowExpressionFixture(layout, "overflow", {})).toThrow(
      /no máximo 16/u,
    )
    expect(() => withWorkflowExpressionFixture(layout, "fixture-0", { replaced: true }))
      .not.toThrow()
  })

  it("fails closed on malformed fixture entries without touching other sidecar fields", () => {
    const layout = {
      workflow: {
        positions: { node: { x: 1, y: 2 } },
        expression_fixtures: {
          valid: { invocation: {} },
          " invalid": { secret: true },
        },
      },
    }
    expect(workflowExpressionFixtures(layout)).toEqual({
      valid: { invocation: {} },
    })
  })
})
