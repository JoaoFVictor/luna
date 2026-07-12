import type { JsonValue } from "@/api/types"

export type WorkflowJsonSchema = Record<string, JsonValue>

export function isWorkflowJsonObject(value: unknown): value is WorkflowJsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function parseWorkflowSchema(
  content: string,
): { schema?: WorkflowJsonSchema; error?: string } {
  try {
    const parsed: unknown = JSON.parse(content)
    return isWorkflowJsonObject(parsed)
      ? { schema: parsed }
      : { error: "O schema precisa ser um objeto JSON." }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : "JSON inválido" }
  }
}

export function workflowSchemaProperties(
  schema: WorkflowJsonSchema,
): Record<string, WorkflowJsonSchema> {
  if (!isWorkflowJsonObject(schema.properties)) return {}
  return Object.fromEntries(
    Object.entries(schema.properties).filter(
      (entry): entry is [string, WorkflowJsonSchema] => isWorkflowJsonObject(entry[1]),
    ),
  )
}

export function workflowSchemaRequired(schema: WorkflowJsonSchema): Set<string> {
  return new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  )
}

export function workflowSchemaWithProperties(
  schema: WorkflowJsonSchema,
  properties: Record<string, WorkflowJsonSchema>,
  required: ReadonlySet<string>,
): WorkflowJsonSchema {
  const next: WorkflowJsonSchema = { ...schema, properties }
  if (required.size === 0) {
    Reflect.deleteProperty(next, "required")
  } else {
    next.required = [...required]
  }
  return next
}
