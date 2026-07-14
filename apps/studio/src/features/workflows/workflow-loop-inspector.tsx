import type { JsonValue } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { workflowNodeField, workflowSourceOutlineEntries, type WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function expressionText(value: JsonValue | undefined): string {
  return isRecord(value) && typeof value.expression === "string"
    ? value.expression
    : "Não declarado"
}

function ReadOnlyValue({ label, value }: { label: string; value: JsonValue | undefined }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-2 text-xs">{value === undefined ? "Não declarado" : JSON.stringify(value, null, 2)}</pre>
    </div>
  )
}

export function WorkflowLoopInspector({
  selected,
  section,
}: {
  selected: Extract<WorkflowSourceNode, { type: "loop" }> | WorkflowSourceNode
  section: "all" | "summary" | "inputs" | "advanced"
}) {
  const body = workflowNodeField(selected, "body")
  const entries = workflowSourceOutlineEntries(body ?? null)
  const bodyIsValidMapping = isRecord(body) && Array.isArray(body.nodes)

  return (
    <div className="mt-4 space-y-5 text-sm">
      {(section === "all" || section === "summary") && (
        <section className="space-y-3 rounded-xl border bg-muted/20 p-3" aria-label="Corpo do loop">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Loop durável</Badge>
            <Badge variant="outline">{entries.length} etapas internas</Badge>
            <Badge variant="secondary">pode interromper</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            O runtime repete este body enquanto a condição permitir. O body é apresentado como uma unidade somente leitura no editor visual para preservar sua cadeia e o checkpoint de revisão.
          </p>
          {!bodyIsValidMapping && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              O body não possui uma sequência de nodes projetável. Corrija o YAML para recuperar a visualização.
            </p>
          )}
          {entries.length > 0 && (
            <ol className="space-y-2" aria-label="Etapas internas do loop">
              {entries.map((entry, index) => {
                const raw = isRecord(entry.raw) ? entry.raw : undefined
                const after = Array.isArray(raw?.after)
                  ? raw.after.filter((value): value is string => typeof value === "string")
                  : []
                return (
                  <li key={`${entry.selectionId}:${index}`} className="rounded-lg border bg-background p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-medium">{index + 1}</span>
                      <span className="font-mono text-xs font-medium">{entry.label}</span>
                      <Badge variant="outline">{entry.typeLabel}</Badge>
                      <span className="text-xs text-muted-foreground">{entry.registrationLabel}</span>
                    </div>
                    {after.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Depois de: {after.join(", ")}</p>}
                    {entry.problems.map((problem) => <p key={problem} className="mt-1 text-xs text-destructive">{problem}</p>)}
                  </li>
                )
              })}
            </ol>
          )}
        </section>
      )}

      {(section === "all" || section === "inputs") && (
        <section className="space-y-3 rounded-xl border p-3" aria-label="Dependências do loop">
          <ReadOnlyValue label="Dependências externas (after)" value={workflowNodeField(selected, "after")} />
        </section>
      )}

      {(section === "all" || section === "advanced") && (
        <section className="space-y-3 rounded-xl border p-3" aria-label="Condições do loop">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Repetir quando</p>
            <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-2 text-xs">{expressionText(workflowNodeField(selected, "repeat_when"))}</pre>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Resultado</p>
            <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-2 text-xs">{expressionText(workflowNodeField(selected, "result"))}</pre>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Encerrar workflow quando</p>
            <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-2 text-xs">{expressionText(workflowNodeField(selected, "halt_when"))}</pre>
          </div>
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
            A criação e a alteração estrutural de loops ainda são feitas no YAML. O Studio não oferece controles visuais parciais para o body.
          </p>
        </section>
      )}
    </div>
  )
}
