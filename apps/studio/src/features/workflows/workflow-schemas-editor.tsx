import { useEffect, useMemo, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { BracesIcon, ListTreeIcon, PlusIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react"
import { StudioJsonValueSchema } from "../../../../../src/studio/contracts/json.js"

import { studioApi } from "@/api/client"
import type { DraftFile, JsonValue } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { draftFileKey, type DraftFileContents } from "@/features/drafts/draft-file-session"
import {
  parseWorkflowSchema,
  type WorkflowJsonSchema,
  workflowSchemaProperties,
  workflowSchemaRequired,
  workflowSchemaWithProperties,
} from "@/features/workflows/workflow-schema-model"

const SUPPORTED_ROOT_KEYWORDS = new Set([
  "$schema",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "description",
  "title",
])
const PROPERTY_TYPES = ["string", "number", "integer", "boolean", "object", "array"] as const

function SchemaTree({
  properties,
  required,
  depth = 0,
}: {
  properties: Record<string, WorkflowJsonSchema>
  required: ReadonlySet<string>
  depth?: number
}) {
  return (
    <ul className={depth === 0 ? "space-y-1" : "mt-1 space-y-1 border-l pl-3"}>
      {Object.entries(properties).map(([name, definition]) => {
        const nested = workflowSchemaProperties(definition)
        return (
          <li key={name} className="text-xs">
            <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
              <code className="min-w-0 flex-1 truncate">{name}</code>
              {required.has(name) && <Badge variant="secondary">required</Badge>}
              <Badge variant="outline">{typeof definition.type === "string" ? definition.type : "any"}</Badge>
            </div>
            {Object.keys(nested).length > 0 && (
              <SchemaTree
                properties={nested}
                required={workflowSchemaRequired(definition)}
                depth={depth + 1}
              />
            )}
          </li>
        )
      })}
      {Object.keys(properties).length === 0 && (
        <li className="text-xs text-muted-foreground">Nenhuma property declarada.</li>
      )}
    </ul>
  )
}

function SchemaBuilder({
  schema,
  disabled,
  onChange,
}: {
  schema: WorkflowJsonSchema
  disabled: boolean
  onChange: (schema: WorkflowJsonSchema) => void
}) {
  const properties = workflowSchemaProperties(schema)
  const required = workflowSchemaRequired(schema)
  const [newProperty, setNewProperty] = useState("")
  const replaceProperty = (name: string, definition: WorkflowJsonSchema) =>
    onChange(workflowSchemaWithProperties(schema, { ...properties, [name]: definition }, required))

  return (
    <div className="space-y-3">
      {Object.entries(properties).map(([name, definition]) => (
        <div key={name} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto_auto] sm:items-center">
          <code className="truncate text-xs">{name}</code>
          <NativeSelect
            value={typeof definition.type === "string" ? definition.type : "string"}
            disabled={disabled}
            onChange={(event) => replaceProperty(name, { ...definition, type: event.target.value })}
          >
            {PROPERTY_TYPES.map((type) => <NativeSelectOption key={type} value={type}>{type}</NativeSelectOption>)}
          </NativeSelect>
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={required.has(name)}
              disabled={disabled}
              onChange={(event) => {
                const next = new Set(required)
                if (event.target.checked) next.add(name)
                else next.delete(name)
                onChange(workflowSchemaWithProperties(schema, properties, next))
              }}
            />
            required
          </label>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={disabled}
            aria-label={`Remover property ${name}`}
            onClick={() => {
              const nextProperties = { ...properties }
              Reflect.deleteProperty(nextProperties, name)
              const nextRequired = new Set(required)
              nextRequired.delete(name)
              onChange(workflowSchemaWithProperties(schema, nextProperties, nextRequired))
            }}
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Input
          value={newProperty}
          disabled={disabled}
          onChange={(event) => setNewProperty(event.target.value)}
          placeholder="nova_property"
          aria-label="Nome da nova property"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || newProperty.trim().length === 0 || Object.hasOwn(properties, newProperty.trim())}
          onClick={() => {
            const name = newProperty.trim()
            if (name.length === 0 || Object.hasOwn(properties, name)) return
            replaceProperty(name, { type: "string" })
            setNewProperty("")
          }}
        >
          <PlusIcon aria-hidden="true" /> Property
        </Button>
      </div>
    </div>
  )
}

export function WorkflowSchemasEditor({
  files,
  contents,
  canMutate,
  acceptProvidedFiles = false,
  onContentChange,
}: {
  files: DraftFile[]
  contents: DraftFileContents
  canMutate: boolean
  acceptProvidedFiles?: boolean
  onContentChange: (key: string, content: string) => void
}) {
  const schemaFiles = useMemo(
    () => files.filter(
      (file) =>
        file.state === "present" &&
        (acceptProvidedFiles || file.file.path.endsWith(".schema.json")),
    ),
    [acceptProvidedFiles, files],
  )
  const [selectedKey, setSelectedKey] = useState<string>()
  const selected = schemaFiles.find((file) => draftFileKey(file) === selectedKey) ?? schemaFiles[0]
  const key = selected === undefined ? undefined : draftFileKey(selected)
  const content = key === undefined ? "" : contents[key] ?? ""
  const parsed = useMemo(() => parseWorkflowSchema(content), [content])
  const schema = parsed.schema
  const unsupported = parsed.schema === undefined
    ? []
    : Object.keys(parsed.schema).filter((keyword) => !SUPPORTED_ROOT_KEYWORDS.has(keyword))
  const [fixture, setFixture] = useState("{}")
  const [fixtureError, setFixtureError] = useState<string>()
  const validation = useMutation({
    mutationFn: ({ schema, instance }: { schema: WorkflowJsonSchema; instance: JsonValue }) =>
      studioApi.validateSchemaInstance({ schema, instance }),
  })

  useEffect(() => {
    if (selectedKey === undefined && schemaFiles[0] !== undefined) {
      setSelectedKey(draftFileKey(schemaFiles[0]))
    }
  }, [schemaFiles, selectedKey])

  if (selected === undefined || key === undefined) {
    return <p className="p-6 text-sm text-muted-foreground">Nenhum arquivo de schema no draft.</p>
  }

  const changeContent = (next: string) => {
    validation.reset()
    onContentChange(key, next)
  }
  const writeSchema = (schema: WorkflowJsonSchema) =>
    changeContent(`${JSON.stringify(schema, null, 2)}\n`)

  return (
    <div className="min-h-[calc(100vh-15rem)] space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <Field className="min-w-64 flex-1">
          <FieldLabel htmlFor="workflow-schema-file">Schema</FieldLabel>
          <NativeSelect
            id="workflow-schema-file"
            className="w-full"
            value={key}
            onChange={(event) => {
              validation.reset()
              setSelectedKey(event.target.value)
            }}
          >
            {schemaFiles.map((file) => (
              <NativeSelectOption key={draftFileKey(file)} value={draftFileKey(file)}>
                {file.file.path.split("/").at(-1)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Badge variant={parsed.error === undefined ? "outline" : "destructive"}>
          {parsed.error === undefined ? "JSON sincronizado" : "JSON inválido"}
        </Badge>
      </div>

      {unsupported.length > 0 && (
        <Alert>
          <AlertTitle>Keywords avançadas preservadas</AlertTitle>
          <AlertDescription>
            {unsupported.join(", ")} não aparecem no builder, mas continuam no JSON. O validator canônico informa se são enforced.
          </AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue={schema === undefined ? "raw" : "builder"}>
          <TabsList>
            <TabsTrigger value="builder"><SlidersHorizontalIcon aria-hidden="true" /> Builder</TabsTrigger>
            <TabsTrigger value="tree"><ListTreeIcon aria-hidden="true" /> Árvore</TabsTrigger>
            <TabsTrigger value="raw"><BracesIcon aria-hidden="true" /> JSON bruto</TabsTrigger>
          </TabsList>
          <TabsContent value="builder" className="pt-4">
            {schema === undefined
              ? <FieldError>{parsed.error ?? "Corrija o JSON bruto para usar o builder."}</FieldError>
              : <SchemaBuilder schema={schema} disabled={!canMutate} onChange={writeSchema} />}
          </TabsContent>
          <TabsContent value="tree" className="pt-4">
            {schema === undefined
              ? <FieldError>{parsed.error ?? "Corrija o JSON bruto para gerar a árvore."}</FieldError>
              : <SchemaTree properties={workflowSchemaProperties(schema)} required={workflowSchemaRequired(schema)} />}
          </TabsContent>
          <TabsContent value="raw" className="pt-4">
            <Textarea
              value={content}
              onChange={(event) => changeContent(event.target.value)}
              disabled={!canMutate}
              spellCheck={false}
              className="min-h-[45vh] font-mono text-xs"
              aria-label={`JSON bruto de ${selected.file.path}`}
            />
          </TabsContent>
        </Tabs>

      <Field data-invalid={fixtureError !== undefined}>
        <FieldLabel htmlFor="schema-fixture">Fixture de instância</FieldLabel>
        <FieldDescription>Valida no servidor sem executar workflow ou acessar filesystem/rede.</FieldDescription>
        <Textarea
          id="schema-fixture"
          value={fixture}
          onChange={(event) => {
            validation.reset()
            setFixtureError(undefined)
            setFixture(event.target.value)
          }}
          className="min-h-24 font-mono text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={validation.isPending || parsed.schema === undefined}
          onClick={() => {
            try {
              const instance = StudioJsonValueSchema.parse(JSON.parse(fixture))
              setFixtureError(undefined)
              if (parsed.schema !== undefined) {
                validation.mutate({ schema: parsed.schema, instance })
              }
            } catch (cause) {
              setFixtureError(cause instanceof Error ? cause.message : "Fixture inválida")
            }
          }}
        >
          {validation.isPending ? "Validando…" : "Validar fixture"}
        </Button>
        {fixtureError !== undefined && <FieldError>{fixtureError}</FieldError>}
      </Field>
      {validation.data !== undefined && (
        <Alert variant={validation.data.status === "valid" ? "default" : "destructive"}>
          <AlertTitle>Fixture {validation.data.status}</AlertTitle>
          <AlertDescription>
            {validation.data.diagnostics.length === 0
              ? "Nenhum diagnostic."
              : validation.data.diagnostics.map((diagnostic) => diagnostic.message).join(" · ")}
          </AlertDescription>
        </Alert>
      )}
      {validation.isError && (
        <FieldError>
          {validation.error instanceof Error ? validation.error.message : "Falha ao validar fixture"}
        </FieldError>
      )}
    </div>
  )
}
