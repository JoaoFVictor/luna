import {
  CheckIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  PinOffIcon,
  PencilIcon,
  ShieldAlertIcon,
} from "lucide-react"
import { useState } from "react"
import { Link } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import type { JsonValue } from "@/api/types"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type {
  WorkflowNodeTestDataState,
  WorkflowTestDataEntry,
} from "@/features/workflows/workflow-test-data-model"
import { WorkflowTestDataSummary } from "@/features/workflows/workflow-test-data-summary"
import { formatDateTime } from "@/lib/format"

export type WorkflowTestDataControls = {
  readonly entries: readonly WorkflowTestDataEntry[]
  readonly activeFixtureNames: ReadonlySet<string>
  readonly previewFixtureName?: string
  readonly nodeStates: ReadonlyMap<string, WorkflowNodeTestDataState>
  readonly panelOpen: boolean
  readonly disabled: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onToggle: (entry: WorkflowTestDataEntry) => void
  readonly onPreview: (entry: WorkflowTestDataEntry) => void
  readonly onClearAll: () => void
  readonly onRemove: (name: string) => void
  readonly onEdit: (entry: WorkflowTestDataEntry, output: JsonValue) => Promise<void>
  readonly onDespin: (entry: WorkflowTestDataEntry) => void
}

function pinnedNodeOutput(entry: WorkflowTestDataEntry): JsonValue | undefined {
  if (
    entry.source === undefined ||
    entry.value === null ||
    Array.isArray(entry.value) ||
    typeof entry.value !== "object"
  ) return undefined
  const steps = entry.value.steps
  if (steps === null || Array.isArray(steps) || typeof steps !== "object") return undefined
  return steps[entry.source.node_id]
}

function EligibilityBadge({ entry }: { entry: WorkflowTestDataEntry }) {
  if (entry.eligibility.kind === "eligible") {
    return <Badge variant="secondary"><CheckIcon aria-hidden="true" /> Pode substituir o node no teste</Badge>
  }
  if (entry.eligibility.reason === "node_missing") {
    return <Badge variant="outline"><ShieldAlertIcon aria-hidden="true" /> Node removido · preview apenas</Badge>
  }
  if (entry.eligibility.reason === "redacted") {
    return <Badge variant="outline"><ShieldAlertIcon aria-hidden="true" /> Redigido · preview apenas</Badge>
  }
  return <Badge variant="outline">Preview apenas</Badge>
}

function EligibilityExplanation({ entry }: { entry: WorkflowTestDataEntry }) {
  if (entry.eligibility.kind === "eligible") {
    return (
      <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-950">
        No teste manual, <strong>{entry.eligibility.nodeId}</strong> será pulado e esta saída será entregue aos próximos passos.
      </p>
    )
  }
  const explanation = entry.eligibility.reason === "manual"
    ? "Pode preencher previews e expressions, mas não pula nenhum node porque não veio de uma execução comprovada."
    : entry.eligibility.reason === "node_missing"
      ? "O node de origem não existe mais neste workflow. Estes dados servem apenas para preview."
      : "A saída foi redigida após a execução e não pode substituir um node com segurança."
  return <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{explanation}</p>
}

function TestDataEntryCard({
  entry,
  substitutionActive,
  previewActive,
  disabled,
  onToggle,
  onPreview,
  onRemove,
  onEdit,
  onDespin,
}: {
  entry: WorkflowTestDataEntry
  substitutionActive: boolean
  previewActive: boolean
  disabled: boolean
  onToggle: () => void
  onPreview: () => void
  onRemove: () => void
  onEdit: (output: JsonValue) => Promise<void>
  onDespin: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draftJson, setDraftJson] = useState("")
  const [jsonError, setJsonError] = useState<string>()
  const [savingEdit, setSavingEdit] = useState(false)
  const startEditing = () => {
    const output = pinnedNodeOutput(entry)
    if (output === undefined) return
    setDraftJson(JSON.stringify(output, null, 2))
    setJsonError(undefined)
    setEditing(true)
  }
  const saveEdit = async () => {
    try {
      const output = JSON.parse(draftJson) as JsonValue
      setSavingEdit(true)
      await onEdit(output)
      setEditing(false)
      setJsonError(undefined)
    } catch (error) {
      setJsonError(error instanceof SyntaxError
        ? "JSON inválido. Corrija a sintaxe antes de salvar."
        : error instanceof Error
          ? error.message
          : "O servidor recusou este output. O JSON foi preservado para correção.")
    } finally {
      setSavingEdit(false)
    }
  }
  return (
    <article className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium">{entry.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {entry.source === undefined
              ? "Criado manualmente no editor"
              : entry.source.kind === "edited_run_node_output"
                ? `Editado a partir do node ${entry.source.node_id}`
                : `Capturado do node ${entry.source.node_id}`}
          </p>
          {entry.source !== undefined && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatDateTime(entry.source.captured_at)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {substitutionActive && (
            <Badge>
              <DatabaseIcon aria-hidden="true" />
              Substituição ativa
            </Badge>
          )}
          {!substitutionActive && previewActive && <Badge variant="secondary">Preview ativo</Badge>}
          <EligibilityBadge entry={entry} />
          {entry.redacted && <Badge variant="secondary">redigido</Badge>}
        </div>
      </div>

      <WorkflowTestDataSummary name={entry.name} value={entry.value} />
      <EligibilityExplanation entry={entry} />

      {entry.source?.kind === "edited_run_node_output" && (
        <p className="text-xs text-muted-foreground">
          Origem {entry.source.source_output_hash.slice(0, 18)}… · edição {entry.source.output_hash.slice(0, 18)}…
        </p>
      )}

      {editing && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            Edite somente o output deste node. O servidor valida limites, schema e segredos; a edição vale apenas em testes manuais deste draft.
          </p>
          <Textarea
            aria-label={`JSON do output fixado ${entry.name}`}
            className="min-h-48 font-mono text-xs"
            value={draftJson}
            onChange={(event) => setDraftJson(event.target.value)}
            spellCheck={false}
          />
          {jsonError !== undefined && <p role="alert" className="text-xs text-destructive">{jsonError}</p>}
          <div className="flex gap-2">
            <Button size="sm" disabled={disabled || savingEdit} onClick={() => void saveEdit()}>
              {savingEdit ? "Salvando…" : "Salvar output de teste"}
            </Button>
            <Button size="sm" variant="ghost" disabled={savingEdit} onClick={() => setEditing(false)}>Cancelar</Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {entry.eligibility.kind === "eligible" ? (
          <Button
            size="sm"
            variant={substitutionActive ? "secondary" : "default"}
            onClick={onToggle}
            aria-pressed={substitutionActive}
          >
            {substitutionActive
              ? <><PinOffIcon aria-hidden="true" /> Não substituir este node</>
              : <><DatabaseIcon aria-hidden="true" /> Substituir este node no teste</>}
          </Button>
        ) : (
          <Button size="sm" variant={previewActive ? "secondary" : "outline"} onClick={onPreview}>
            {previewActive
              ? <><CheckIcon aria-hidden="true" /> Preview ativo</>
              : <><DatabaseIcon aria-hidden="true" /> Usar somente no preview</>}
          </Button>
        )}
        {entry.source !== undefined && (
          <>
            {!entry.redacted && (
              <Button size="sm" variant="outline" disabled={disabled} onClick={startEditing}>
                <PencilIcon aria-hidden="true" /> Editar JSON
              </Button>
            )}
            <Link
              className={buttonVariants({ size: "sm", variant: "outline" })}
              to={`/runs/${encodeURIComponent(entry.source.run_id)}`}
            >
              <ExternalLinkIcon aria-hidden="true" /> Abrir execução
            </Link>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={onDespin}>
              <PinOffIcon aria-hidden="true" /> Desvincular autorização
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onRemove}
          aria-label={`Remover dados de preview ${entry.name}`}
        >
          <PinOffIcon aria-hidden="true" /> Remover
        </Button>
      </div>
    </article>
  )
}

export function WorkflowTestDataBar({ controls }: { controls: WorkflowTestDataControls }) {
  const activeEntries = controls.entries.filter((entry) =>
    controls.activeFixtureNames.has(entry.name),
  )
  const preview = controls.entries.find((entry) =>
    entry.name === controls.previewFixtureName,
  )
  if (controls.entries.length === 0) return null

  return (
    <>
      <section className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-3 py-2" aria-label="Dados de teste do workflow">
        <Button size="sm" variant="outline" onClick={() => controls.onOpenChange(true)}>
          <DatabaseIcon aria-hidden="true" /> Dados de teste · {controls.entries.length}
        </Button>
        {activeEntries.length > 0 ? (
          <>
            <Badge>
              <DatabaseIcon aria-hidden="true" />
              {activeEntries.length} {activeEntries.length === 1 ? "node substituído" : "nodes substituídos"}
            </Badge>
            <span className="max-w-md truncate text-xs text-muted-foreground">
              {activeEntries.map((entry) => entry.source?.node_id ?? entry.name).join(" · ")}
            </span>
            <Button size="sm" variant="ghost" onClick={controls.onClearAll}>Limpar tudo</Button>
          </>
        ) : preview !== undefined ? (
          <><Badge variant="secondary">Preview ativo · {preview.name}</Badge><Button size="sm" variant="ghost" onClick={controls.onClearAll}>Limpar tudo</Button></>
        ) : (
          <span className="text-xs text-muted-foreground">Nenhum node será substituído neste teste.</span>
        )}
        <span className="text-xs text-muted-foreground">
          Dados elegíveis substituem o node somente neste teste manual; execuções instaladas ignoram a seleção.
        </span>
      </section>

      <Sheet open={controls.panelOpen} onOpenChange={controls.onOpenChange}>
        <SheetContent className="sm:max-w-xl">
          <SheetHeader className="border-b">
            <SheetTitle>Dados de teste</SheetTitle>
            <SheetDescription>
              Escolha dados para preview e teste manual. A seleção fica no link do editor, não altera o YAML e nunca afeta produção.
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
            <div className="space-y-3">
              {controls.entries.map((entry) => (
                <TestDataEntryCard
                  key={entry.name}
                  entry={entry}
                  substitutionActive={controls.activeFixtureNames.has(entry.name)}
                  previewActive={entry.name === controls.previewFixtureName}
                  disabled={controls.disabled}
                  onToggle={() => controls.onToggle(entry)}
                  onPreview={() => controls.onPreview(entry)}
                  onRemove={() => controls.onRemove(entry.name)}
                  onEdit={(output) => controls.onEdit(entry, output)}
                  onDespin={() => controls.onDespin(entry)}
                />
              ))}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  )
}
