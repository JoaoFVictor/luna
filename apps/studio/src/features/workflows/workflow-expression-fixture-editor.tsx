import { useEffect, useId, useMemo, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { EyeIcon, SaveIcon, Trash2Icon } from "lucide-react"
import { StudioExpressionEvaluationRequestSchema } from "../../../../../src/studio/contracts/expression-evaluation.js"

import { studioApi } from "@/api/client"
import type { ExpressionEvaluation, JsonValue } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import type { WorkflowExpressionFixtures } from "@/features/workflows/workflow-expression-fixtures"

const NEW_FIXTURE_OPTION = "__new_fixture__"
const DEFAULT_FIXTURE_NAME = "default"
const DEFAULT_FIXTURE: JsonValue = {
  invocation: {},
  config: {},
  steps: {},
  workspace: {},
}

function formatted(value: JsonValue): string {
  return JSON.stringify(value, null, 2)
}

function resultText(result: ExpressionEvaluation | undefined): string | undefined {
  if (result === undefined) return undefined
  if (result.status === "error") return result.diagnostics[0]?.message ?? "Expression inválida"
  return result.result.kind === "undefined"
    ? "undefined"
    : JSON.stringify(result.result.value, null, 2)
}

function firstFixture(fixtures: WorkflowExpressionFixtures): {
  readonly name: string
  readonly value: JsonValue
} {
  const name = Object.keys(fixtures)[0]
  return name === undefined
    ? { name: DEFAULT_FIXTURE_NAME, value: DEFAULT_FIXTURE }
    : { name, value: fixtures[name] ?? DEFAULT_FIXTURE }
}

export function WorkflowExpressionFixtureEditor({
  fieldName,
  expression,
  fixtures,
  activeFixtureName,
  disabled,
  onSave,
  onRemove,
  onSelect,
}: {
  fieldName: string
  expression: string
  fixtures: WorkflowExpressionFixtures
  activeFixtureName?: string
  disabled: boolean
  onSave: (name: string, value: JsonValue) => void
  onRemove: (name: string) => void
  onSelect?: (name: string) => void
}) {
  const initial = activeFixtureName !== undefined && Object.hasOwn(fixtures, activeFixtureName)
    ? { name: activeFixtureName, value: fixtures[activeFixtureName] ?? DEFAULT_FIXTURE }
    : firstFixture(fixtures)
  const id = useId()
  const [fixtureName, setFixtureName] = useState(initial.name)
  const [fixture, setFixture] = useState(formatted(initial.value))
  const [error, setError] = useState<string>()
  const fixtureNames = useMemo(() => Object.keys(fixtures), [fixtures])
  const selectedIsSaved = Object.hasOwn(fixtures, fixtureName)
  const selectedFixture = selectedIsSaved ? fixtures[fixtureName] : undefined
  const evaluate = useMutation({
    mutationFn: (value: JsonValue) => studioApi.evaluateExpression({ expression, fixture: value }),
  })
  const resetEvaluation = evaluate.reset

  useEffect(() => {
    resetEvaluation()
  }, [expression, resetEvaluation])

  useEffect(() => {
    if (selectedFixture !== undefined) setFixture(formatted(selectedFixture))
  }, [selectedFixture])

  useEffect(() => {
    if (
      activeFixtureName === undefined ||
      activeFixtureName === fixtureName ||
      !Object.hasOwn(fixtures, activeFixtureName)
    ) return
    setFixtureName(activeFixtureName)
    setFixture(formatted(fixtures[activeFixtureName] ?? DEFAULT_FIXTURE))
    setError(undefined)
    resetEvaluation()
  }, [activeFixtureName, fixtureName, fixtures, resetEvaluation])

  const parseFixture = (): JsonValue | undefined => {
    try {
      const parsed = StudioExpressionEvaluationRequestSchema.shape.fixture.parse(
        JSON.parse(fixture),
      )
      setError(undefined)
      return parsed
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Fixture inválida")
      return undefined
    }
  }

  const selectFixture = (name: string) => {
    evaluate.reset()
    setError(undefined)
    if (name === NEW_FIXTURE_OPTION) {
      setFixtureName(DEFAULT_FIXTURE_NAME)
      setFixture(formatted(DEFAULT_FIXTURE))
      return
    }
    setFixtureName(name)
    setFixture(formatted(fixtures[name] ?? DEFAULT_FIXTURE))
    onSelect?.(name)
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <Field>
        <FieldLabel htmlFor={`${id}-saved`}>Fixture salva</FieldLabel>
        <NativeSelect
          id={`${id}-saved`}
          value={selectedIsSaved ? fixtureName : NEW_FIXTURE_OPTION}
          disabled={disabled}
          onChange={(event) => selectFixture(event.target.value)}
        >
          <NativeSelectOption value={NEW_FIXTURE_OPTION}>Nova fixture…</NativeSelectOption>
          {fixtureNames.map((name) => (
            <NativeSelectOption key={name} value={name}>{name}</NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>
          Persistida somente no sidecar do draft; não altera o YAML nem executa o workflow.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>Nome da fixture</FieldLabel>
        <Input
          id={`${id}-name`}
          value={fixtureName}
          maxLength={64}
          disabled={disabled}
          onChange={(event) => {
            setFixtureName(event.target.value)
            setError(undefined)
          }}
        />
      </Field>
      <Field data-invalid={error !== undefined}>
        <FieldLabel htmlFor={`${id}-content`}>Fixture para preview — {fieldName}</FieldLabel>
        <Textarea
          id={`${id}-content`}
          value={fixture}
          onChange={(event) => setFixture(event.target.value)}
          disabled={disabled || evaluate.isPending}
          className="min-h-24 font-mono text-xs"
          aria-invalid={error !== undefined}
        />
        {error !== undefined && <FieldError>{error}</FieldError>}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || evaluate.isPending || expression.length === 0}
          onClick={() => {
            const parsed = parseFixture()
            if (parsed !== undefined) evaluate.mutate(parsed)
          }}
        >
          <EyeIcon aria-hidden="true" /> {evaluate.isPending ? "Avaliando…" : "Preview seguro"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || fixtureName.trim().length === 0}
          onClick={() => {
            const parsed = parseFixture()
            if (parsed === undefined) return
            try {
              onSave(fixtureName.trim(), parsed)
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Não foi possível salvar a fixture")
            }
          }}
        >
          <SaveIcon aria-hidden="true" /> Salvar no draft
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !selectedIsSaved}
          onClick={() => {
            onRemove(fixtureName)
            const nextFixtures = Object.fromEntries(
              Object.entries(fixtures).filter(([name]) => name !== fixtureName),
            ) as WorkflowExpressionFixtures
            const next = firstFixture(nextFixtures)
            setFixtureName(next.name)
            setFixture(formatted(next.value))
            evaluate.reset()
          }}
        >
          <Trash2Icon aria-hidden="true" /> Excluir fixture
        </Button>
      </div>
      {evaluate.data !== undefined && (
        <Alert variant={evaluate.data.status === "error" ? "destructive" : "default"}>
          <AlertTitle>{evaluate.data.status === "error" ? "Expression inválida" : "Resultado da fixture"}</AlertTitle>
          <AlertDescription>
            <pre className="mt-1 max-h-40 overflow-auto text-xs">{resultText(evaluate.data)}</pre>
          </AlertDescription>
        </Alert>
      )}
      {evaluate.isError && <FieldError>{evaluate.error.message}</FieldError>}
    </div>
  )
}
