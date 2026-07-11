import { useEffect, useId, useMemo, useState } from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { StudioJsonValueSchema } from "../../../../../src/studio/contracts/json.js"

import type { JsonValue, YamlSourceOperation } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { WorkflowExpressionFixtureEditor } from "@/features/workflows/workflow-expression-fixture-editor"
import type { WorkflowExpressionFixtures } from "@/features/workflows/workflow-expression-fixtures"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

type InputMode = "literal" | "expression"

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function expressionValue(value: JsonValue): string | undefined {
  return isRecord(value) && typeof value.expression === "string"
    ? value.expression
    : undefined
}

function referencedUnknownNode(
  expression: string,
  nodeIds: ReadonlySet<string>,
): string | undefined {
  for (const match of expression.matchAll(/\$\.steps\.([A-Za-z0-9_-]+)/gu)) {
    const nodeId = match[1]
    if (nodeId !== undefined && !nodeIds.has(nodeId)) return nodeId
  }
  return undefined
}

function WorkflowInputField({
  name,
  value,
  nodeIds,
  fixtures,
  disabled,
  onChange,
  onRemove,
  onSaveFixture,
  onRemoveFixture,
}: {
  name: string
  value: JsonValue
  nodeIds: ReadonlySet<string>
  fixtures: WorkflowExpressionFixtures
  disabled: boolean
  onChange: (value: JsonValue) => void
  onRemove: () => void
  onSaveFixture: (name: string, value: JsonValue) => void
  onRemoveFixture: (name: string) => void
}) {
  const fieldId = useId()
  const sourceExpression = expressionValue(value)
  const [mode, setMode] = useState<InputMode>(
    sourceExpression === undefined ? "literal" : "expression",
  )
  const [literal, setLiteral] = useState(
    sourceExpression === undefined ? JSON.stringify(value, null, 2) : "null",
  )
  const [expression, setExpression] = useState(sourceExpression ?? "$.invocation")
  const [error, setError] = useState<string>()

  useEffect(() => {
    const nextExpression = expressionValue(value)
    setMode(nextExpression === undefined ? "literal" : "expression")
    if (nextExpression === undefined) setLiteral(JSON.stringify(value, null, 2))
    else setExpression(nextExpression)
    setError(undefined)
  }, [value])

  const unknownNode = useMemo(
    () => mode === "expression" ? referencedUnknownNode(expression, nodeIds) : undefined,
    [expression, mode, nodeIds],
  )
  const suggestions = [
    "$.invocation",
    "$.config",
    "$.workspace",
    ...[...nodeIds].map((nodeId) => `$.steps.${nodeId}`),
  ]

  const save = () => {
    try {
      const next = mode === "expression"
        ? StudioJsonValueSchema.parse({ expression })
        : StudioJsonValueSchema.parse(JSON.parse(literal))
      setError(undefined)
      onChange(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Valor inválido")
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 text-xs font-medium">{name}</code>
        <Badge variant={mode === "expression" ? "secondary" : "outline"}>
          {mode === "expression" ? "expression" : "literal"}
        </Badge>
        <Button size="icon-xs" variant="ghost" disabled={disabled} onClick={onRemove} aria-label={`Remover input ${name}`}>
          <Trash2Icon aria-hidden="true" />
        </Button>
      </div>
      <Field>
        <FieldLabel htmlFor={`${fieldId}-mode`}>Modo</FieldLabel>
        <NativeSelect
          id={`${fieldId}-mode`}
          value={mode}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value as InputMode
            setMode(next)
          }}
        >
          <NativeSelectOption value="literal">Literal JSON</NativeSelectOption>
          <NativeSelectOption value="expression">Expression / JSONata</NativeSelectOption>
        </NativeSelect>
      </Field>

      {mode === "literal" ? (
        <Textarea
          value={literal}
          onChange={(event) => setLiteral(event.target.value)}
          disabled={disabled}
          className="min-h-20 font-mono text-xs"
          aria-label={`Valor literal de ${name}`}
        />
      ) : (
        <>
          <Field data-invalid={unknownNode !== undefined}>
            <FieldLabel htmlFor={`${fieldId}-expression`}>Expression</FieldLabel>
            <Input
              id={`${fieldId}-expression`}
              list={`${fieldId}-roots`}
              value={expression}
              onChange={(event) => setExpression(event.target.value)}
              disabled={disabled}
              className="font-mono text-xs"
              aria-invalid={unknownNode !== undefined}
            />
            <datalist id={`${fieldId}-roots`}>
              {suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}
            </datalist>
            <FieldDescription>
              Roots disponíveis: $.invocation, $.config, $.steps e $.workspace. JSONata avançado é aceito pelo evaluator isolado.
            </FieldDescription>
            {unknownNode !== undefined && (
              <FieldError>O node {unknownNode} não existe nesta fonte.</FieldError>
            )}
          </Field>
          <WorkflowExpressionFixtureEditor
            fieldName={name}
            expression={expression}
            fixtures={fixtures}
            disabled={disabled}
            onSave={onSaveFixture}
            onRemove={onRemoveFixture}
          />
        </>
      )}

      <div className="flex justify-end">
        <Button size="sm" variant="outline" disabled={disabled || unknownNode !== undefined} onClick={save}>
          Salvar input
        </Button>
      </div>
      {error !== undefined && <FieldError>{error}</FieldError>}
    </div>
  )
}

export function WorkflowExpressionBuilder({
  node,
  nodes,
  canMutate,
  pending,
  onOperations,
  fixtures,
  onSaveFixture,
  onRemoveFixture,
}: {
  node: WorkflowSourceNode
  nodes: readonly WorkflowSourceNode[]
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
  fixtures: WorkflowExpressionFixtures
  onSaveFixture: (name: string, value: JsonValue) => void
  onRemoveFixture: (name: string) => void
}) {
  const rawInput = node.value.input
  const inputs = isRecord(rawInput) ? rawInput : {}
  const [newField, setNewField] = useState("")
  const nodeIds = useMemo(() => new Set(nodes.map((candidate) => candidate.id)), [nodes])
  const disabled = !canMutate || pending

  const replaceInputs = (next: Record<string, JsonValue>) => {
    onOperations([
      Object.keys(next).length === 0
        ? { op: "delete", path: ["nodes", node.index, "input"] }
        : { op: "set", path: ["nodes", node.index, "input"], value: next },
    ])
  }

  return (
    <Field>
      <FieldLabel>Inputs e expressions</FieldLabel>
      <FieldDescription>
        Strings literais e expressions são modos distintos. O preview usa fixture limitada e nunca executa o workflow.
      </FieldDescription>
      <div className="space-y-3">
        {Object.entries(inputs).map(([name, value]) => (
          <WorkflowInputField
            key={`${node.id}:${name}`}
            name={name}
            value={value}
            nodeIds={nodeIds}
            fixtures={fixtures}
            disabled={disabled}
            onChange={(nextValue) => replaceInputs({ ...inputs, [name]: nextValue })}
            onRemove={() => {
              const next = { ...inputs }
              Reflect.deleteProperty(next, name)
              replaceInputs(next)
            }}
            onSaveFixture={onSaveFixture}
            onRemoveFixture={onRemoveFixture}
          />
        ))}
        <div className="flex gap-2">
          <Input
            value={newField}
            onChange={(event) => setNewField(event.target.value)}
            disabled={disabled}
            placeholder="novo_campo"
            aria-label="Nome do novo input"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || newField.trim().length === 0 || Object.hasOwn(inputs, newField.trim())}
            onClick={() => {
              const name = newField.trim()
              if (name.length === 0 || Object.hasOwn(inputs, name)) return
              replaceInputs({ ...inputs, [name]: null })
              setNewField("")
            }}
          >
            <PlusIcon aria-hidden="true" /> Campo
          </Button>
        </div>
      </div>
    </Field>
  )
}
