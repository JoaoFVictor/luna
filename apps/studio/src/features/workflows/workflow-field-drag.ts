export const WORKFLOW_FIELD_DRAG_MIME = "application/x-luna-workflow-field+json"

const MAX_EXPRESSION_LENGTH = 2_000

export function workflowFieldDragPayload(expression: string): string {
  return JSON.stringify({ version: 1, expression })
}

export function parseWorkflowFieldDragPayload(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > MAX_EXPRESSION_LENGTH + 64) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("version" in value) ||
      value.version !== 1 ||
      !("expression" in value) ||
      typeof value.expression !== "string" ||
      value.expression.length === 0 ||
      value.expression.length > MAX_EXPRESSION_LENGTH ||
      !value.expression.startsWith("$.")
    ) {
      return undefined
    }
    return value.expression
  } catch {
    return undefined
  }
}
