import { CheckCircle2Icon, CircleAlertIcon } from "lucide-react"

import type { AdapterRoutingPreview } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function AdapterRoutingPreviewPanel({
  result,
}: {
  result: AdapterRoutingPreview
}) {
  return (
    <section className="grid gap-4 lg:grid-cols-2" aria-label="Preview não autoritativo do adapter">
      <Card>
        <CardHeader>
          <CardTitle>Invocation projetada pelo preview</CardTitle>
          <CardDescription>
            Campos redigidos: {result.adapter.redacted_fields.join(", ") || "nenhum"}. Esta projeção não é o payload usado pelo run.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs">
            {JSON.stringify(result.adapter.invocation, null, 2)}
          </pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Routing do preview
            {result.routing.status === "matched" ? (
              <CheckCircle2Icon className="size-4 text-emerald-600" aria-hidden="true" />
            ) : (
              <CircleAlertIcon className="size-4 text-amber-600" aria-hidden="true" />
            )}
          </CardTitle>
          <CardDescription>
            {result.routing.target === null
              ? "Nenhum target selecionado nesta simulação."
              : `Target simulado: workflow:${result.routing.target.id}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert>
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>Preview e plano são operações diferentes</AlertTitle>
            <AlertDescription>
              O preview explica parsing e first-match routing. Somente o plano autoritativo abaixo carrega config instalada, captura a definição e pode ser confirmado para execução.
            </AlertDescription>
          </Alert>
          <ol className="space-y-2">
            {result.routing.evaluations.map((evaluation) => (
              <li
                key={`${evaluation.rule_index}:${evaluation.rule_id}`}
                className="flex items-start gap-2 rounded-lg border p-2 text-sm"
              >
                <Badge variant="outline">{evaluation.rule_index + 1}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{evaluation.rule_id}</p>
                  <p className="text-xs text-muted-foreground">
                    {evaluation.outcome === "boolean"
                      ? `resultado: ${String(evaluation.result)}`
                      : evaluation.diagnostic.message}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </section>
  )
}
