import { useEffect, useId, useMemo, useState } from "react"
import { LockKeyholeIcon, SaveIcon } from "lucide-react"

import type { ConfigurationField, JsonValue } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

type ConfigurationFieldEditorProps = {
  field: ConfigurationField
  canMutate: boolean
  pending: boolean
  onSave: (path: readonly string[], value: JsonValue) => void
}

function displayName(field: ConfigurationField): string {
  return field.title ?? field.path.at(-1) ?? field.expression
}

function valueText(field: ConfigurationField): string {
  if (!field.present || field.value === undefined) return ""
  if (Array.isArray(field.value)) return field.value.map(String).join("\n")
  return String(field.value)
}

function arrayValue(field: ConfigurationField, text: string): JsonValue | undefined {
  const values = text
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  switch (field.value_type) {
    case "string_array":
      return values
    case "boolean_array":
      return values.every((value) => value === "true" || value === "false")
        ? values.map((value) => value === "true")
        : undefined
    case "integer_array": {
      const numbers = values.map(Number)
      return numbers.every(Number.isSafeInteger) ? numbers : undefined
    }
    case "number_array": {
      const numbers = values.map(Number)
      return numbers.every(Number.isFinite) ? numbers : undefined
    }
    default:
      return undefined
  }
}

function scalarValue(field: ConfigurationField, text: string): JsonValue | undefined {
  if (field.value_type === "string") return text
  const normalized = text.trim()
  if (normalized === "") return undefined
  if (field.value_type === "integer") {
    const value = Number(normalized)
    return Number.isSafeInteger(value) ? value : undefined
  }
  if (field.value_type === "number") {
    const value = Number(normalized)
    return Number.isFinite(value) ? value : undefined
  }
  return undefined
}

export function ConfigurationFieldEditor({
  field,
  canMutate,
  pending,
  onSave,
}: ConfigurationFieldEditorProps) {
  const inputId = useId()
  const serverText = valueText(field)
  const [text, setText] = useState(serverText)
  useEffect(() => setText(serverText), [serverText])

  const editable =
    canMutate && field.exposure === "editable" && field.present && !pending
  const candidate = useMemo(
    () =>
      field.value_type.endsWith("_array")
        ? arrayValue(field, text)
        : scalarValue(field, text),
    [field, text],
  )
  const changed =
    candidate !== undefined && JSON.stringify(candidate) !== JSON.stringify(field.value)
  const help = field.description ?? field.expression
  const selectedEnumIndex =
    field.enum_values?.findIndex((value) => value === field.value) ?? -1

  return (
    <div className="grid gap-3 rounded-xl border bg-card/50 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <Field className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <FieldLabel htmlFor={inputId}>
            {displayName(field)}
          </FieldLabel>
          <Badge variant="outline">{field.value_type}</Badge>
          {field.exposure === "read_only" && (
            <Badge variant="secondary">
              <LockKeyholeIcon aria-hidden="true" /> somente leitura
            </Badge>
          )}
          {!field.present && <Badge variant="secondary">ausente</Badge>}
        </div>

        {field.value_type === "boolean" ? (
          <div className="flex min-h-8 items-center gap-3">
            <Switch
              id={inputId}
              checked={field.value === true}
              disabled={!editable}
              onCheckedChange={(checked) => onSave(field.path, checked)}
              aria-label={displayName(field)}
            />
            <span className="text-sm text-muted-foreground">
              {field.value === true ? "Ativado" : "Desativado"}
            </span>
          </div>
        ) : field.enum_values !== undefined ? (
          <NativeSelect
            id={inputId}
            className="w-full"
            value={selectedEnumIndex < 0 ? "" : String(selectedEnumIndex)}
            disabled={!editable}
            onChange={(event) => {
              const selected = field.enum_values?.[Number(event.target.value)]
              if (selected !== undefined) onSave(field.path, selected)
            }}
          >
            {field.enum_values.map((value, index) => (
              <NativeSelectOption key={index} value={String(index)}>
                {String(value)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : field.value_type.endsWith("_array") ? (
          <Textarea
            id={inputId}
            value={text}
            disabled={!editable}
            rows={Math.max(3, Array.isArray(field.value) ? field.value.length : 3)}
            onChange={(event) => setText(event.target.value)}
            placeholder="Um valor por linha"
          />
        ) : (
          <Input
            id={inputId}
            type={field.value_type === "string" ? "text" : "number"}
            step={field.value_type === "integer" ? 1 : "any"}
            min={field.minimum}
            max={field.maximum}
            minLength={field.min_length}
            maxLength={field.max_length}
            value={text}
            disabled={!editable}
            onChange={(event) => setText(event.target.value)}
            autoComplete="off"
          />
        )}
        <FieldDescription>
          {help}
          {field.value_type.endsWith("_array") ? " · um valor por linha" : ""}
        </FieldDescription>
      </Field>

      {field.value_type !== "boolean" && field.enum_values === undefined && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="sm:mt-7"
          disabled={!editable || !changed}
          onClick={() => candidate !== undefined && onSave(field.path, candidate)}
        >
          <SaveIcon aria-hidden="true" /> Salvar campo
        </Button>
      )}
    </div>
  )
}
