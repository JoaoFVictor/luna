import { TriangleAlertIcon } from "lucide-react"

import type { RunRecord } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { runFailurePresentation } from "@/features/runs/run-failure-presentation"
import { humanizeTechnicalId } from "@/lib/presentation"

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  configuration: "configuração",
  validation: "validação",
  authentication: "autenticação",
  authorization: "autorização",
  dependency: "dependência",
  transport: "transporte",
  rate_limit: "limite de requisições",
  timeout: "tempo esgotado",
  runtime: "runtime",
  external: "serviço externo",
  unknown: "não classificado",
}

const RETRYABILITY_LABELS: Readonly<Record<string, string>> = {
  safe: "seguro",
  unsafe: "não repetir automaticamente",
  conditional: "revisar antes de repetir",
  unknown: "desconhecido",
}

export function RunFailureCallout({ record }: { record: RunRecord }) {
  if (record.failure === undefined) return null

  const presentation = runFailurePresentation(record.failure, record.failed_node_id, record.run_status)
  const reachedRuntime = record.started_at !== undefined || record.dispatch_status === "started"
  const diagnostics = record.failure.diagnostics

  return (
    <Alert variant="destructive" className="border-destructive/40 bg-destructive/5 px-4 py-3">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle className="text-base">{presentation.title}</AlertTitle>
      <AlertDescription>
        <p>{presentation.description}</p>
        {record.failed_node_id !== undefined ? (
          <p className="mt-2">
            A execução parou em <strong>{humanizeTechnicalId(record.failed_node_id)}</strong>. Passos concluídos antes da falha e seus resultados continuam disponíveis; passos dependentes podem não ter executado.
          </p>
        ) : reachedRuntime ? (
          <p className="mt-2">A execução iniciou, mas não foi possível identificar com segurança qual passo causou a falha.</p>
        ) : (
          <p className="mt-2">O workflow foi rejeitado antes de qualquer passo começar.</p>
        )}
        <details className="mt-3 rounded-md border border-destructive/20 bg-background/60 px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium">Detalhes técnicos</summary>
          <dl className="mt-2 grid gap-1">
            <div><dt className="inline text-muted-foreground">Código: </dt><dd className="inline font-mono">{record.failure.code}</dd></div>
            <div><dt className="inline text-muted-foreground">Mensagem: </dt><dd className="inline break-words">{record.failure.message}</dd></div>
            {diagnostics?.category !== undefined && (
              <div><dt className="inline text-muted-foreground">Categoria: </dt><dd className="inline">{CATEGORY_LABELS[diagnostics.category] ?? diagnostics.category}</dd></div>
            )}
            {diagnostics?.retryability !== undefined && (
              <div><dt className="inline text-muted-foreground">Repetir: </dt><dd className="inline">{RETRYABILITY_LABELS[diagnostics.retryability] ?? diagnostics.retryability}</dd></div>
            )}
            {diagnostics?.certainty !== undefined && (
              <div><dt className="inline text-muted-foreground">Certeza: </dt><dd className="inline">{diagnostics.certainty === "known" ? "resultado conhecido" : "resultado incerto"}</dd></div>
            )}
            {diagnostics?.operation_id !== undefined && (
              <div><dt className="inline text-muted-foreground">Operação: </dt><dd className="inline font-mono">{diagnostics.operation_id}</dd></div>
            )}
            {diagnostics?.status_code !== undefined && (
              <div><dt className="inline text-muted-foreground">Status: </dt><dd className="inline font-mono">{diagnostics.status_code}</dd></div>
            )}
            {diagnostics?.cause !== undefined && (
              <div>
                <dt className="text-muted-foreground">Causa preservada</dt>
                <dd className="mt-1 break-words font-mono">
                  {[diagnostics.cause.code, diagnostics.cause.message].filter((value) => value !== undefined).join(" · ")}
                </dd>
              </div>
            )}
          </dl>
        </details>
      </AlertDescription>
    </Alert>
  )
}
