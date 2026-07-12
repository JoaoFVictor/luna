import type { RunRecord } from "@/api/types"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { formatDateTime } from "@/lib/format"

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
          <details><summary className="cursor-pointer text-xs text-muted-foreground">Identificadores técnicos</summary><pre className="mt-2 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify({ workflow_revision: record.workflow_revision, definition_bundle: record.definition_bundle_hash, execution_snapshot: record.execution_snapshot_hash, accepted_plan: record.accepted_plan_id, source: record.source }, null, 2)}</pre></details>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3"><CardTitle>Permissões previstas</CardTitle><CardDescription>Ações externas que poderiam ocorrer.</CardDescription></CardHeader>
        <CardContent>
          {record.side_effects.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum efeito externo planejado.</p> : (
            <>
              <p className="text-sm font-medium">{record.side_effects.length} {record.side_effects.length === 1 ? "ação prevista" : "ações previstas"}</p>
              <details className="mt-3 rounded-lg border bg-muted/30">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">Ver detalhes técnicos</summary>
                <div className="max-h-64 overflow-y-auto overscroll-contain border-t px-3 py-3">
                  <pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(record.side_effects, null, 2)}</pre>
                </div>
              </details>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
