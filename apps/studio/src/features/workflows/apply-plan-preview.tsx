import { AlertTriangleIcon, CheckCircle2Icon, FileDiffIcon } from "lucide-react"

import type { ApplyPlan } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { WorkflowSideEffectPreview } from "@/features/workflows/workflow-side-effect-preview"
import { pathLabel } from "@/lib/format"

function SideEffectReview({
  sideEffects,
}: {
  sideEffects: readonly WorkflowSideEffectPreview[]
}) {
  return sideEffects.length === 0 ? (
    <Alert>
      <CheckCircle2Icon aria-hidden="true" />
      <AlertTitle>Nenhum side effect potencial identificado</AlertTitle>
      <AlertDescription>
        Esta estimativa considera policies e referências de agents resolvíveis no catálogo carregado. O preflight do run continua sendo a autoridade para efeitos da execução; artifacts do runtime não contam como efeito externo.
      </AlertDescription>
    </Alert>
  ) : (
    <Alert variant="destructive">
      <AlertTriangleIcon aria-hidden="true" />
      <AlertTitle>Revise os side effects potenciais</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-4">
          {sideEffects.map((effect, index) => (
            <li key={`${effect.nodeId}:${effect.source}:${index}`}>
              <code>{effect.nodeId}</code>: {effect.description} ({effect.semantics})
              {effect.operationIds.length > 0 ? ` — ${effect.operationIds.join(", ")}` : ""}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

export function ApplyPlanPreview({
  plan,
  sideEffects,
}: {
  plan: ApplyPlan | undefined
  sideEffects: readonly WorkflowSideEffectPreview[]
}) {
  if (plan === undefined) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Gere o plano autoritativo para revisar todos os arquivos.</p>
  }

  return (
    <div className="space-y-4">
      <SideEffectReview sideEffects={sideEffects} />
      {plan.status === "conflicted" ? (
        <>
          <Alert variant="destructive">
            <AlertTriangleIcon aria-hidden="true" />
            <AlertTitle>Conflito externo detectado</AlertTitle>
            <AlertDescription>
              A origem mudou depois da abertura do draft. Nenhum arquivo foi sobrescrito.
            </AlertDescription>
          </Alert>
          <div className="space-y-2">
            {plan.conflicts.map((conflict) => (
              <div key={pathLabel(conflict.file)} className="rounded-lg border p-3 text-sm">
                <p className="font-mono text-xs">{pathLabel(conflict.file)}</p>
                <p className="mt-1 text-xs text-muted-foreground">Esperado: {conflict.expected_sha256 ?? "ausente"}</p>
                <p className="text-xs text-muted-foreground">Atual: {conflict.actual_sha256 ?? "ausente"}</p>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <Alert>
            <CheckCircle2Icon aria-hidden="true" />
            <AlertTitle>Plano pronto</AlertTitle>
            <AlertDescription>
              Token válido até {new Date(plan.expires_at).toLocaleString("pt-BR")}. O servidor recalcula hashes sob lock durante o apply.
            </AlertDescription>
          </Alert>
          {plan.diff.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma diferença para aplicar.</p>
          ) : (
            <ScrollArea className="max-h-[52vh]">
              <div className="space-y-3 pr-3">
                {plan.diff.map((file) => (
                  <section key={pathLabel(file.file)} className="overflow-hidden rounded-lg border">
                    <header className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
                      <FileDiffIcon className="size-4" aria-hidden="true" />
                      <code className="min-w-0 flex-1 truncate text-xs">{pathLabel(file.file)}</code>
                      <Badge variant="outline">{file.kind}</Badge>
                    </header>
                    <pre className="max-h-72 overflow-auto p-3 text-xs leading-relaxed">{file.textual_diff || "(diff textual vazio)"}</pre>
                    {file.textual_diff_truncated && <p className="border-t px-3 py-2 text-xs text-muted-foreground">Diff truncado pelo limite seguro do servidor.</p>}
                  </section>
                ))}
              </div>
            </ScrollArea>
          )}
        </>
      )}
    </div>
  )
}
