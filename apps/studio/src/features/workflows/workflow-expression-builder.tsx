import { useEffect, useId, useMemo, useState } from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { StudioJsonValueSchema } from "../../../../../src/studio/contracts/json.js"

import type { JsonValue, YamlSourceOperation } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { WorkflowExpressionFixtureEditor } from "@/features/workflows/workflow-expression-fixture-editor"
import type { WorkflowExpressionFixtures } from "@/features/workflows/workflow-expression-fixtures"
import { WorkflowLiteralInput } from "@/features/workflows/workflow-literal-input"
import {
  WORKFLOW_FIELD_DRAG_MIME,
  parseWorkflowFieldDragPayload,
} from "@/features/workflows/workflow-field-drag"
import {
  workflowAvailableInputNodes,
  workflowFieldPathLabel,
  workflowInputPathExists,
  workflowInputPathValue,
  workflowRemoveInputPath,
  workflowSchemaFieldDefault,
  workflowSchemaTypesCompatible,
  workflowSetInputPath,
  workflowStepFieldExpression,
  type WorkflowSchemaField,
} from "@/features/workflows/workflow-data-mapping"
import { WorkflowSourceFieldPicker } from "@/features/workflows/workflow-source-field-picker"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"
import { humanizeTechnicalId } from "@/lib/presentation"
import { cn } from "@/lib/utils"

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
  path,
  value,
  nodeIds,
  fixtures,
  activeFixtureName,
  disabled,
  onChange,
  onRemove,
  onSaveFixture,
  onRemoveFixture,
  onSelectFixture,
  availableSources,
  availableSourceFields,
  expectedValueType,
}: {
  path: readonly string[]
  value: JsonValue
  nodeIds: ReadonlySet<string>
  fixtures: WorkflowExpressionFixtures
  activeFixtureName?: string
  disabled: boolean
  onChange: (value: JsonValue) => void
  onRemove: () => void
  onSaveFixture: (name: string, value: JsonValue) => void
  onRemoveFixture: (name: string) => void
  onSelectFixture?: (name: string) => void
  availableSources: readonly WorkflowSourceNode[]
  availableSourceFields: ReadonlyMap<string, readonly WorkflowSchemaField[]>
  expectedValueType?: string
}) {
  const fieldId = useId()
  const name = workflowFieldPathLabel(path)
  const displayName = humanizeTechnicalId(path.at(-1) ?? name, true)
  const sourceExpression = expressionValue(value)
  const [mode, setMode] = useState<InputMode>(
    sourceExpression === undefined ? "literal" : "expression",
  )
  const [literal, setLiteral] = useState(
    sourceExpression === undefined ? JSON.stringify(value, null, 2) : "null",
  )
  const [expression, setExpression] = useState(sourceExpression ?? "$.invocation")
  const [error, setError] = useState<string>()
  const [dragActive, setDragActive] = useState(false)

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
      const root = workflowStepFieldExpression(node.id)
      const fields = availableSourceFields.get(node.id) ?? []
      return [
        { value: root, label: `Passo: ${node.id}`, valueType: "unknown" },
        ...fields.map((field) => ({
          value: workflowStepFieldExpression(node.id, field.path),
          label: `${node.id} › ${workflowFieldPathLabel(field.path)}`,
          valueType: field.valueType,
        })),
      ]
    }),
  ].map((suggestion) => ({
    ...suggestion,
    compatible: workflowSchemaTypesCompatible(expectedValueType, suggestion.valueType),
  }))
  const selectedSuggestion = suggestions.find((suggestion) => suggestion.value === expression)
  const incompatibleType = selectedSuggestion !== undefined &&
    !workflowSchemaTypesCompatible(expectedValueType, selectedSuggestion.valueType)

  const applyMapping = (nextExpression: string) => {
    if (disabled) return
    const suggestion = suggestions.find((candidate) => candidate.value === nextExpression)
    if (suggestion === undefined || !suggestion.compatible) {
      setError("Este dado não é compatível com o parâmetro de destino.")
      return
    }
    setMode("expression")
    setExpression(nextExpression)
    setError(undefined)
    onChange({ expression: nextExpression })
  }

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
    <div
      className={cn(
        "space-y-3 rounded-lg border p-3 transition-colors",
        dragActive && "border-primary bg-primary/5 ring-2 ring-primary/20",
      )}
      role="group"
      aria-label={`Parâmetro ${displayName}`}
      data-mapping-target={name}
      onDragEnter={(event) => {
        if (disabled) return
        if (!event.dataTransfer.types.includes(WORKFLOW_FIELD_DRAG_MIME)) return
        event.preventDefault()
        setDragActive(true)
      }}
      onDragOver={(event) => {
        if (disabled) return
        if (!event.dataTransfer.types.includes(WORKFLOW_FIELD_DRAG_MIME)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
      }}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) return
        setDragActive(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(WORKFLOW_FIELD_DRAG_MIME)) return
        event.preventDefault()
        setDragActive(false)
        if (disabled) return
        const dropped = parseWorkflowFieldDragPayload(
          event.dataTransfer.getData(WORKFLOW_FIELD_DRAG_MIME),
        )
        if (dropped !== undefined) applyMapping(dropped)
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{displayName}</p>
          <code className="text-[11px] text-muted-foreground">{name}</code>
        </div>
        <Badge variant={mode === "expression" ? "secondary" : "outline"}>
          {mode === "expression" ? "dados de outro passo" : "valor fixo"}
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
          <NativeSelectOption value="literal">Valor fixo</NativeSelectOption>
          <NativeSelectOption value="expression">Dados de outro passo</NativeSelectOption>
        </NativeSelect>
      </Field>

      {mode === "literal" ? (
        <WorkflowLiteralInput id={`${fieldId}-literal`} name={path.at(-1) ?? name} value={literal} valueType={expectedValueType} disabled={disabled} onChange={setLiteral} />
      ) : (
        <>
          <Field data-invalid={unknownNode !== undefined || incompatibleType}>
            <FieldLabel htmlFor={`${fieldId}-expression`}>Usar dados de</FieldLabel>
            <div className="grid gap-3">
              <WorkflowSourceFieldPicker
                suggestions={suggestions}
                selectedValue={expression}
                disabled={disabled}
                onSelect={applyMapping}
              />
              <div className="rounded-lg border bg-muted/20 p-3 lg:min-h-52">
                <p className="mb-2 text-xs font-medium">Campo de destino</p>
                <Input
                  id={`${fieldId}-expression`}
                  list={`${fieldId}-roots`}
                  value={expression}
                  onChange={(event) => setExpression(event.target.value)}
                  disabled={disabled}
                  className="font-mono text-xs"
                  aria-invalid={unknownNode !== undefined || incompatibleType}
                />
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Solte um dado neste parâmetro ou edite o caminho quando precisar de JSONata avançado.
                </p>
              </div>
            </div>
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
            activeFixtureName={activeFixtureName}
            disabled={disabled}
            onSave={onSaveFixture}
            onRemove={onRemoveFixture}
            onSelect={onSelectFixture}
          />
        </>
      )}

      <div className="flex justify-end">
        <Button size="sm" variant="outline" disabled={disabled || unknownNode !== undefined || incompatibleType} onClick={save}>
          Salvar campo
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
  activeFixtureName,
  onSaveFixture,
  onRemoveFixture,
  onSelectFixture,
  suggestedFields = [],
  availableSourceFields = EMPTY_SOURCE_FIELDS,
}: {
  node: WorkflowSourceNode
  nodes: readonly WorkflowSourceNode[]
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
  fixtures: WorkflowExpressionFixtures
  activeFixtureName?: string
  onSaveFixture: (name: string, value: JsonValue) => void
  onRemoveFixture: (name: string) => void
  onSelectFixture?: (name: string) => void
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

  const editableSuggestedFields = suggestedFields.filter((field) =>
    !suggestedFields.some((candidate) =>
      candidate.path.length > field.path.length &&
      field.path.every((segment, index) => candidate.path[index] === segment),
    ),
  )
  const suggestedEntries = editableSuggestedFields.flatMap((field) => {
    const value = workflowInputPathValue(inputs, field.path)
    return value === undefined ? [] : [{ field, value }]
  })
  const suggestedRoots = new Set(editableSuggestedFields.map((field) => field.path[0]))
  const customEntries = Object.entries(inputs).flatMap(([name, value]) =>
    suggestedRoots.has(name)
      ? []
      : [{ field: { path: [name], valueType: "unknown" }, value }],
  )
  const inputEntries = [...suggestedEntries, ...customEntries]

  return (
    <Field>
      <FieldLabel>Dados de entrada</FieldLabel>
      <FieldDescription>
        Defina valores fixos ou use dados produzidos pelos passos anteriores.
      </FieldDescription>
      <div className="space-y-3">
        {inputEntries.map(({ field, value }) => (
          <WorkflowInputField
            key={`${node.id}:${JSON.stringify(field.path)}`}
            path={field.path}
            value={value}
            nodeIds={nodeIds}
            fixtures={fixtures}
            activeFixtureName={activeFixtureName}
            disabled={disabled}
            onChange={(nextValue) => replaceInputs(
              workflowSetInputPath(inputs, field.path, nextValue),
            )}
            onRemove={() => replaceInputs(workflowRemoveInputPath(inputs, field.path))}
            onSaveFixture={onSaveFixture}
            onRemoveFixture={onRemoveFixture}
            onSelectFixture={onSelectFixture}
            availableSources={availableSources}
            availableSourceFields={availableSourceFields}
            expectedValueType={field.valueType}
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
              replaceInputs(workflowSetInputPath(inputs, [name], null))
              setNewField("")
            }}
          >
            <PlusIcon aria-hidden="true" /> Campo
          </Button>
        </div>
        {editableSuggestedFields.some((field) => !workflowInputPathExists(inputs, field.path)) && (
          <div className="flex flex-wrap gap-1">
            {editableSuggestedFields.filter((field) => !workflowInputPathExists(inputs, field.path)).map((field) => (
              <Button key={JSON.stringify(field.path)} type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => replaceInputs(workflowSetInputPath(inputs, field.path, workflowSchemaFieldDefault(field)))}>
                <PlusIcon aria-hidden="true" /> {workflowFieldPathLabel(field.path)} · {field.valueType}
              </Button>
            ))}
          </div>
        )}
      </div>
    </Field>
  )
}
