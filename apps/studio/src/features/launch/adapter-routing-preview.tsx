import { CheckCircle2Icon, CircleAlertIcon } from "lucide-react"

import type { AdapterRoutingPreview } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function AdapterRoutingPreviewPanel({
  result,
}: {
  result: AdapterRoutingPreview
}) {
  return (
    <section aria-label="Prévia da rota da entrada">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {result.routing.status === "matched" ? "Workflow encontrado" : "Nenhum workflow correspondeu"}
            {result.routing.status === "matched" ? (
              <CheckCircle2Icon className="size-4 text-emerald-600" aria-hidden="true" />
            ) : (
              <CircleAlertIcon className="size-4 text-amber-600" aria-hidden="true" />
            )}
          </CardTitle>
          <CardDescription>
            {result.routing.target === null
              ? "Revise a entrada ou as regras ordenadas de routing."
              : `A primeira regra correspondente escolheu ${result.routing.target.id}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">As regras são avaliadas de cima para baixo; a primeira correspondência vence.</p>
          <ol className="space-y-2">
            {result.routing.evaluations.map((evaluation) => (
              <li
                key={`${evaluation.rule_index}:${evaluation.rule_id}`}
                className="flex items-start gap-2 rounded-lg border p-2 text-sm"
              >
                <Badge variant="outline">{evaluation.rule_index + 1}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Regra {evaluation.rule_index + 1}</p>
                  <p className="text-xs text-muted-foreground">
                    {evaluation.outcome === "boolean"
                      ? evaluation.result ? "Correspondeu a esta entrada" : "Não correspondeu"
                      : evaluation.diagnostic.message}
                  </p>
                  <code className="mt-1 block text-[10px] text-muted-foreground">{evaluation.rule_id}</code>
                </div>
              </li>
            ))}
          </ol>
          <details className="rounded-lg border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Invocation e campos técnicos</summary>
            <div className="border-t p-3">
              <p className="mb-2 text-xs text-muted-foreground">Campos ocultados: {result.adapter.redacted_fields.join(", ") || "nenhum"}.</p>
              <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(result.adapter.invocation, null, 2)}</pre>
            </div>
          </details>
        </CardContent>
      </Card>
    </section>
  )
}
