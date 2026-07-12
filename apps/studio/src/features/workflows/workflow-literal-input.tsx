import { StudioJsonValueSchema } from "../../../../../src/studio/contracts/json.js"

import type { JsonValue } from "@/api/types"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { humanizeTechnicalId } from "@/lib/presentation"

function parsedLiteral(value: string): JsonValue | undefined {
  try {
    return StudioJsonValueSchema.parse(JSON.parse(value))
  } catch {
    return undefined
  }
}

export function WorkflowLiteralInput({
  id,
  name,
  value,
  valueType,
  disabled,
  onChange,
}: {
  id: string
  name: string
  value: string
  valueType: string | undefined
  disabled: boolean
  onChange: (value: string) => void
}) {
  const parsed = parsedLiteral(value)
  const label = humanizeTechnicalId(name, true)

  if (valueType === "string") {
    return (
      <Field>
        <FieldLabel htmlFor={id}>Valor</FieldLabel>
        <Input id={id} value={typeof parsed === "string" ? parsed : ""} onChange={(event) => onChange(JSON.stringify(event.target.value))} disabled={disabled} aria-label={`Valor de ${label}`} />
      </Field>
    )
  }

  if (valueType === "integer" || valueType === "number") {
    return (
      <Field>
        <FieldLabel htmlFor={id}>Valor</FieldLabel>
        <Input id={id} type="number" step={valueType === "integer" ? 1 : "any"} value={typeof parsed === "number" ? String(parsed) : ""} onChange={(event) => onChange(event.target.value === "" ? "null" : String(Number(event.target.value)))} disabled={disabled} aria-label={`Valor de ${label}`} />
      </Field>
    )
  }

  if (valueType === "boolean") {
    return (
      <Field>
        <FieldLabel htmlFor={id}>Valor</FieldLabel>
        <NativeSelect id={id} value={parsed === true ? "true" : "false"} onChange={(event) => onChange(event.target.value)} disabled={disabled} aria-label={`Valor de ${label}`}>
          <NativeSelectOption value="true">Sim</NativeSelectOption>
          <NativeSelectOption value="false">Não</NativeSelectOption>
        </NativeSelect>
      </Field>
    )
  }

  return (
    <Textarea value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} className="min-h-20 font-mono text-xs" aria-label={`Valor JSON de ${label}`} />
  )
}
