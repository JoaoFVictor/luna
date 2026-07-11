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
import { workflowAvailableInputNodes } from "@/features/workflows/workflow-data-mapping"
import { workflowSchemaTypesCompatible, type WorkflowSchemaField } from "@/features/workflows/workflow-data-mapping"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

type InputMode = "literal" | "expression"
const EMPTY_SOURCE_FIELDS: ReadonlyMap<string, readonly WorkflowSchemaField[]> = new Map()

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
  availableSources,
  availableSourceFields,
  expectedValueType,
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
  availableSources: readonly WorkflowSourceNode[]
  availableSourceFields: ReadonlyMap<string, readonly WorkflowSchemaField[]>
  expectedValueType?: string
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
    { value: "$.invocation", label: "Entrada do workflow", valueType: "unknown" },
    { value: "$.config", label: "Configuração", valueType: "unknown" },
    { value: "$.workspace", label: "Workspace", valueType: "unknown" },
    ...availableSources.flatMap((node) => {
      const root = `$.steps.${node.id}`
      const fields = availableSourceFields.get(node.id) ?? []
      return [
        { value: root, label: `Passo: ${node.id}`, valueType: "unknown" },
        ...fields.map((field) => ({
          value: `${root}.${field.path}`,
          label: `${node.id} › ${field.path}`,
          valueType: field.valueType,
        })),
      ]
    }),
  ]
  const selectedSuggestion = suggestions.find((suggestion) => suggestion.value === expression)
  const incompatibleType = selectedSuggestion !== undefined &&
    !workflowSchemaTypesCompatible(expectedValueType, selectedSuggestion.valueType)

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
          <Field data-invalid={unknownNode !== undefined || incompatibleType}>
            <FieldLabel htmlFor={`${fieldId}-expression`}>Usar dados de</FieldLabel>
            <div className="mb-2 flex flex-wrap gap-1">
              {suggestions.map((suggestion) => (
                <Button
                  key={suggestion.value}
                  type="button"
                  size="xs"
                  variant={workflowSchemaTypesCompatible(expectedValueType, suggestion.valueType) ? "outline" : "destructive"}
                  draggable
                  title="Clique ou arraste para o campo"
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", suggestion.value)
                    event.dataTransfer.effectAllowed = "copy"
                  }}
                  onClick={() => setExpression(suggestion.value)}
                >
                  {suggestion.label} · {suggestion.valueType}
                </Button>
              ))}
            </div>
            <Input
              id={`${fieldId}-expression`}
              list={`${fieldId}-roots`}
              value={expression}
              onChange={(event) => setExpression(event.target.value)}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = "copy"
              }}
              onDrop={(event) => {
                event.preventDefault()
                const dropped = event.dataTransfer.getData("text/plain")
                if (dropped.startsWith("$.")) setExpression(dropped)
              }}
              disabled={disabled}
              className="font-mono text-xs"
              aria-invalid={unknownNode !== undefined}
            />
            <datalist id={`${fieldId}-roots`}>
              {suggestions.map((suggestion) => <option key={suggestion.value} value={suggestion.value} />)}
            </datalist>
            <FieldDescription>
              Escolha uma origem acima ou refine o caminho manualmente. JSONata continua disponível no modo avançado.
            </FieldDescription>
            {unknownNode !== undefined && (
              <FieldError>O node {unknownNode} não existe nesta fonte.</FieldError>
            )}
            {incompatibleType && (
              <FieldError>
                Tipo incompatível: este campo espera {expectedValueType}, mas a origem declara {selectedSuggestion.valueType}.
              </FieldError>
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
        <Button size="sm" variant="outline" disabled={disabled || unknownNode !== undefined || incompatibleType} onClick={save}>
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
  suggestedFields = [],
  availableSourceFields = EMPTY_SOURCE_FIELDS,
}: {
  node: WorkflowSourceNode
  nodes: readonly WorkflowSourceNode[]
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
  fixtures: WorkflowExpressionFixtures
  onSaveFixture: (name: string, value: JsonValue) => void
  onRemoveFixture: (name: string) => void
  suggestedFields?: readonly WorkflowSchemaField[]
  availableSourceFields?: ReadonlyMap<string, readonly WorkflowSchemaField[]>
}) {
  const rawInput = node.value.input
  const inputs = isRecord(rawInput) ? rawInput : {}
  const [newField, setNewField] = useState("")
  const nodeIds = useMemo(() => new Set(nodes.map((candidate) => candidate.id)), [nodes])
  const availableSources = useMemo(
    () => workflowAvailableInputNodes(node, nodes),
    [node, nodes],
  )
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
      <FieldLabel>Dados de entrada</FieldLabel>
      <FieldDescription>
        Defina valores fixos ou use dados produzidos pelos passos anteriores.
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
            availableSources={availableSources}
            availableSourceFields={availableSourceFields}
            expectedValueType={suggestedFields.find((field) => field.path === name)?.valueType}
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
        {suggestedFields.some((field) => !Object.hasOwn(inputs, field.path)) && (
          <div className="flex flex-wrap gap-1">
            {suggestedFields.filter((field) => !Object.hasOwn(inputs, field.path)).map((field) => (
              <Button key={field.path} type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => replaceInputs({ ...inputs, [field.path]: null })}>
                <PlusIcon aria-hidden="true" /> {field.path} · {field.valueType}
              </Button>
            ))}
          </div>
        )}
      </div>
    </Field>
  )
}
