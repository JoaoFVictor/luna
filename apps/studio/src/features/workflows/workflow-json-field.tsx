import { useEffect, useState } from "react"
import { StudioJsonValueSchema } from "../../../../../src/studio/contracts/json.js"

import type { JsonValue, YamlSourceOperation } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"

export function WorkflowJsonField({
  label,
  description,
  path,
  value,
  canMutate,
  pending,
  onOperations,
}: {
  label: string
  description?: string
  path: readonly (string | number)[]
  value: JsonValue | undefined
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
}) {
  const serialized = value === undefined ? "" : JSON.stringify(value, null, 2)
  const [text, setText] = useState(serialized)
  const [error, setError] = useState<string>()

  useEffect(() => {
    setText(serialized)
    setError(undefined)
  }, [serialized])

  const save = () => {
    if (text.trim() === "") {
      if (value !== undefined) onOperations([{ op: "delete", path: [...path] }])
      return
    }
    try {
      const parsed = StudioJsonValueSchema.parse(JSON.parse(text))
      setError(undefined)
      onOperations([{ op: "set", path: [...path], value: parsed }])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "JSON inválido")
    }
  }

  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel>{label}</FieldLabel>
      {description !== undefined && <FieldDescription>{description}</FieldDescription>}
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={!canMutate || pending}
        spellCheck={false}
        className="min-h-28 font-mono text-xs"
        aria-invalid={error !== undefined}
        aria-label={`${label} em JSON`}
      />
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canMutate || pending || text === serialized}
          onClick={save}
        >
          {text.trim() === "" && value !== undefined ? "Remover" : "Salvar"}
        </Button>
      </div>
      {error !== undefined && <FieldError>{error}</FieldError>}
    </Field>
  )
}
