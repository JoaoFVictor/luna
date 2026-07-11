import { StudioExpressionEvaluationRequestSchema } from "../../../../../src/studio/contracts/expression-evaluation.js"

import type { JsonValue } from "@/api/types"

export const WORKFLOW_EXPRESSION_FIXTURE_LIMITS = Object.freeze({
  maxFixtures: 16,
  maxNameLength: 64,
} as const)

export type WorkflowExpressionFixtures = Readonly<Record<string, JsonValue>>

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validFixtureName(name: string): boolean {
  return (
    name.length <= WORKFLOW_EXPRESSION_FIXTURE_LIMITS.maxNameLength &&
    /^[A-Za-z0-9][A-Za-z0-9._ -]*$/u.test(name)
  )
}

export function assertWorkflowExpressionFixtureName(name: string): void {
  if (!validFixtureName(name)) {
    throw new Error(
      "O nome da fixture deve começar com letra ou número e usar no máximo 64 caracteres.",
    )
  }
}

export function workflowExpressionFixtures(
  layout: JsonValue | undefined,
): WorkflowExpressionFixtures {
  if (
    !isRecord(layout) ||
    !isRecord(layout.workflow) ||
    !isRecord(layout.workflow.expression_fixtures)
  ) {
    return {}
  }

  const fixtures: Record<string, JsonValue> = Object.create(null)
  for (const [name, value] of Object.entries(layout.workflow.expression_fixtures)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, WORKFLOW_EXPRESSION_FIXTURE_LIMITS.maxFixtures)) {
    const parsed = StudioExpressionEvaluationRequestSchema.shape.fixture.safeParse(value)
    if (validFixtureName(name) && parsed.success) fixtures[name] = parsed.data
  }
  return fixtures
}

export function withWorkflowExpressionFixture(
  layout: JsonValue | undefined,
  name: string,
  value: JsonValue,
): JsonValue {
  assertWorkflowExpressionFixtureName(name)
  const parsed = StudioExpressionEvaluationRequestSchema.shape.fixture.parse(value)
  const fixtures = workflowExpressionFixtures(layout)
  if (
    !Object.hasOwn(fixtures, name) &&
    Object.keys(fixtures).length >= WORKFLOW_EXPRESSION_FIXTURE_LIMITS.maxFixtures
  ) {
    throw new Error(
      `O draft aceita no máximo ${WORKFLOW_EXPRESSION_FIXTURE_LIMITS.maxFixtures} fixtures de expression.`,
    )
  }

  const root = isRecord(layout) ? { ...layout } : {}
  const workflow = isRecord(root.workflow) ? { ...root.workflow } : {}
  return {
    ...root,
    workflow: {
      ...workflow,
      expression_fixtures: { ...fixtures, [name]: parsed },
    },
  }
}

export function withoutWorkflowExpressionFixture(
  layout: JsonValue | undefined,
  name: string,
): JsonValue {
  const fixtures = { ...workflowExpressionFixtures(layout) }
  Reflect.deleteProperty(fixtures, name)
  const root = isRecord(layout) ? { ...layout } : {}
  const workflow = isRecord(root.workflow) ? { ...root.workflow } : {}
  const nextWorkflow = { ...workflow }

  if (Object.keys(fixtures).length === 0) {
    Reflect.deleteProperty(nextWorkflow, "expression_fixtures")
  } else {
    nextWorkflow.expression_fixtures = fixtures
  }
  return { ...root, workflow: nextWorkflow }
}
