import type { JsonValue } from "@/api/types"
import { Badge } from "@/components/ui/badge"

type TestDataShape = {
  readonly label: string
  readonly fields: readonly string[]
}

export function workflowTestDataShape(value: JsonValue): TestDataShape {
  if (Array.isArray(value)) {
    return {
      label: `${value.length} ${value.length === 1 ? "item" : "itens"}`,
      fields: [],
    }
  }
  if (value !== null && typeof value === "object") {
    const fields = Object.keys(value)
    return {
      label: `${fields.length} ${fields.length === 1 ? "campo" : "campos"}`,
      fields,
    }
  }
  if (value === null) return { label: "Valor nulo", fields: [] }
  return { label: `Valor ${typeof value === "string" ? "de texto" : typeof value}`, fields: [] }
}

export function WorkflowTestDataSummary({
  name,
  value,
}: {
  name: string
  value: JsonValue
}) {
  const shape = workflowTestDataShape(value)
  const visibleFields = shape.fields.slice(0, 5)
  const hiddenFieldCount = shape.fields.length - visibleFields.length

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>{shape.label}</span>
        {visibleFields.map((field) => <Badge key={field} variant="outline">{field}</Badge>)}
        {hiddenFieldCount > 0 && <span>+{hiddenFieldCount}</span>}
      </div>
      <details className="rounded-md border bg-muted/30">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Ver JSON técnico</summary>
        <pre
          className="max-h-64 overflow-auto border-t p-3 text-xs"
          aria-label={`JSON dos dados ${name}`}
          tabIndex={0}
        >
          {JSON.stringify(value, null, 2)}
        </pre>
      </details>
    </div>
  )
}
