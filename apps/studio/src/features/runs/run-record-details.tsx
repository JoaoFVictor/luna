import type { JsonValue, RunRecord } from "@/api/types"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { formatDateTime } from "@/lib/format"
import { humanizeTechnicalId } from "@/lib/presentation"

type SideEffectObject = { readonly [key: string]: JsonValue }

function asObject(value: JsonValue): SideEffectObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined
}

function stringField(value: SideEffectObject | undefined, key: string): string | undefined {
  const field = value?.[key]
  return typeof field === "string" && field.length > 0 ? field : undefined
}

function sideEffectTitle(effect: JsonValue, index: number): string {
  const object = asObject(effect)
  const description = stringField(object, "description")
  if (description !== undefined) return description
  const operation = stringField(object, "operation_id")
  if (operation !== undefined) return humanizeTechnicalId(operation, true)
  return `Ação prevista ${index + 1}`
}

function sideEffectCategory(effect: JsonValue): string | undefined {
  const category = stringField(asObject(effect), "category")
  return category === undefined ? undefined : humanizeTechnicalId(category, true)
}

function sideEffectLocation(effect: JsonValue): string | undefined {
  const object = asObject(effect)
  const node = stringField(object, "node_id")
  const operation = stringField(object, "operation_id")
  if (node !== undefined && operation !== undefined) return `${humanizeTechnicalId(node, true)} · ${operation}`
  if (node !== undefined) return `Etapa: ${humanizeTechnicalId(node, true)}`
  return operation
}

function confirmationLabel(effect: JsonValue): string | undefined {
  const confirmation = asObject(effect)?.confirmation_required
  if (typeof confirmation !== "boolean") return undefined
  return confirmation ? "Confirmação necessária" : "Sem confirmação adicional"
}

export function RunRecordDetails({ record }: { record: RunRecord }) {
  const inputProvenance = record.input_provenance?.kind === "adapter"
    ? `adapter ${record.input_provenance.adapter_id} · ${record.input_provenance.adapter_input_hash}`
    : record.input_provenance?.kind === "invocation"
      ? "invocation JSON direta"
      : "—"

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3"><CardTitle>Contexto</CardTitle><CardDescription>Origem e horários da execução.</CardDescription></CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          {[
            ["Criada", formatDateTime(record.created_at)],
            ["Iniciada", formatDateTime(record.started_at)],
            ["Finalizada", formatDateTime(record.finished_at)],
            ["Origem", inputProvenance],
            ["Repositório", record.repository_id ?? "—"],
          ].map(([label, value], index) => <div key={label}>{index > 0 && <Separator className="mb-2.5" />}<p className="text-xs text-muted-foreground">{label}</p><p className="break-all font-mono text-xs">{value}</p></div>)}
          <details><summary className="cursor-pointer text-xs text-muted-foreground">Identificadores técnicos</summary><pre className="mt-2 max-w-full whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{JSON.stringify({ workflow_revision: record.workflow_revision, definition_bundle: record.definition_bundle_hash, execution_snapshot: record.execution_snapshot_hash, accepted_plan: record.accepted_plan_id, source: record.source }, null, 2)}</pre></details>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3"><CardTitle>Permissões previstas</CardTitle><CardDescription>Ações externas que poderiam ocorrer.</CardDescription></CardHeader>
        <CardContent>
          {record.side_effects.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum efeito externo planejado.</p> : (
            <>
              <p className="text-sm font-medium">{record.side_effects.length} {record.side_effects.length === 1 ? "ação prevista" : "ações previstas"}</p>
              <div className="mt-3 space-y-2" aria-label="Ações previstas">
                {record.side_effects.map((effect, index) => {
                  const category = sideEffectCategory(effect)
                  const location = sideEffectLocation(effect)
                  const confirmation = confirmationLabel(effect)
                  return (
                    <div key={`${index}-${category ?? "effect"}`} className="rounded-lg border bg-muted/20 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="min-w-0 text-sm font-medium break-words">{sideEffectTitle(effect, index)}</p>
                        {category !== undefined && <Badge variant="outline">{category}</Badge>}
                      </div>
                      {(location !== undefined || confirmation !== undefined) && (
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          {location !== undefined && <span className="break-all">{location}</span>}
                          {confirmation !== undefined && <span>{confirmation}</span>}
                        </div>
                      )}
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground">Dados técnicos</summary>
                        <pre className="mt-2 max-w-full whitespace-pre-wrap break-all rounded-lg bg-muted p-2 text-xs">{JSON.stringify(effect, null, 2)}</pre>
                      </details>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
