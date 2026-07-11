import { useEffect, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { FileJsonIcon, SaveIcon } from "lucide-react"
import { STUDIO_DRAFT_AUTHORING_LIMITS } from "../../../../../src/studio/contracts/draft-authoring.js"
import { StudioJsonValueSchema } from "../../../../../src/studio/contracts/json.js"

import { studioApi } from "@/api/client"
import type { DraftFile, JsonValue } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { draftFileKey } from "@/features/drafts/draft-file-session"
import { useServerBackedForm } from "@/features/agents/use-server-backed-form"
import { WorkflowSchemasEditor } from "@/features/workflows/workflow-schemas-editor"

type JsonObject = { [key: string]: JsonValue }

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function AgentOutputContractSection({
  file,
  content,
  disabled,
  pending,
  onDirtyChange,
  onSave,
}: {
  file: DraftFile
  content: string
  disabled: boolean
  pending: boolean
  onDirtyChange: (dirty: boolean) => void
  onSave: (content: string) => void
}) {
  const editor = useServerBackedForm(content)
  const key = draftFileKey(file)
  const bytes = new TextEncoder().encode(editor.value).byteLength
  const tooLarge =
    editor.value.length > STUDIO_DRAFT_AUTHORING_LIMITS.maxContentCharacters ||
    bytes > STUDIO_DRAFT_AUTHORING_LIMITS.maxContentBytes

  useEffect(() => onDirtyChange(editor.dirty), [editor.dirty, onDirtyChange])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 sm:px-6 sm:pt-6">
        <div>
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold"><FileJsonIcon className="size-4" aria-hidden="true" /> Formato da resposta</h2>
            <p className="mt-1 text-xs text-muted-foreground">Defina os campos que este agent deve entregar para os próximos passos do workflow.</p>
          </div>
          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Arquivo técnico</summary><code>{file.file.path}</code></details>
        </div>
        <Badge variant={tooLarge ? "destructive" : "outline"}>{bytes.toLocaleString()} bytes UTF-8</Badge>
      </div>
      <WorkflowSchemasEditor
        files={[file]}
        contents={{ [key]: editor.value }}
        canMutate={!disabled}
        acceptProvidedFiles
        onContentChange={(_key, next) => editor.setValue(next)}
      />
      <div className="flex flex-wrap items-center gap-2 px-4 pb-4 sm:px-6 sm:pb-6">
        <Button disabled={disabled || pending || !editor.dirty || tooLarge} onClick={() => onSave(editor.value)}>
          <SaveIcon aria-hidden="true" />{pending ? "Salvando…" : "Salvar formato"}
        </Button>
        {editor.dirty && <Button variant="ghost" onClick={editor.reset}>Descartar alterações</Button>}
        {!editor.dirty && <Badge variant="outline">sincronizado</Badge>}
      </div>
    </div>
  )
}

export function AgentRegisteredOutputContractSection({
  schemaId,
  schema,
}: {
  schemaId: string
  schema: JsonValue
}) {
  const [fixture, setFixture] = useState("{}")
  const [fixtureError, setFixtureError] = useState<string>()
  const schemaObject = isJsonObject(schema) ? schema : undefined
  const validation = useMutation({
    mutationFn: (instance: JsonValue) => {
      if (schemaObject === undefined) throw new Error("O schema registrado não é um objeto JSON")
      return studioApi.validateSchemaInstance({ schema: schemaObject, instance })
    },
  })

  return (
    <div className="space-y-5">
      <Alert>
        <FileJsonIcon aria-hidden="true" />
        <AlertTitle>Schema registrado: {schemaId}</AlertTitle>
        <AlertDescription>Este contrato pertence ao capability registry e é read-only aqui. Edite a capability proprietária para alterá-lo.</AlertDescription>
      </Alert>
      <pre className="max-h-[28rem] overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs">{JSON.stringify(schema, null, 2)}</pre>
      {schemaObject === undefined && <FieldError>O capability registry projetou um schema que não é um objeto JSON; a fixture foi bloqueada.</FieldError>}
      <Field data-invalid={fixtureError !== undefined}>
        <FieldLabel htmlFor="agent-registered-schema-fixture">Fixture de instância</FieldLabel>
        <Textarea
          id="agent-registered-schema-fixture"
          value={fixture}
          className="min-h-28 font-mono text-xs"
          onChange={(event) => {
            validation.reset()
            setFixtureError(undefined)
            setFixture(event.target.value)
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={validation.isPending || schemaObject === undefined}
          onClick={() => {
            try {
              const instance = StudioJsonValueSchema.parse(JSON.parse(fixture))
              setFixtureError(undefined)
              validation.mutate(instance)
            } catch (cause) {
              setFixtureError(cause instanceof Error ? cause.message : "Fixture inválida")
            }
          }}
        >
          {validation.isPending ? "Validando…" : "Validar fixture no servidor"}
        </Button>
        {fixtureError !== undefined && <FieldError>{fixtureError}</FieldError>}
      </Field>
      {validation.data !== undefined && (
        <Alert variant={validation.data.status === "valid" ? "default" : "destructive"}>
          <AlertTitle>Fixture {validation.data.status}</AlertTitle>
          <AlertDescription>{validation.data.diagnostics.map((diagnostic) => diagnostic.message).join(" · ") || "Nenhum diagnostic."}</AlertDescription>
        </Alert>
      )}
      {validation.isError && <FieldError>{validation.error instanceof Error ? validation.error.message : "Falha ao validar fixture"}</FieldError>}
    </div>
  )
}
