import { AlertCircleIcon, AlertTriangleIcon, ArrowRightIcon, CheckCircle2Icon } from "lucide-react"

import type { ValidationDiagnostic } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { pathLabel } from "@/lib/format"

export function ProblemsPanel({
  diagnostics,
  validated,
  onOpenDiagnostic,
  onValidate,
  validating = false,
}: {
  diagnostics: ValidationDiagnostic[]
  validated: boolean
  onOpenDiagnostic?: (diagnostic: ValidationDiagnostic) => void
  onValidate?: () => void
  validating?: boolean
}) {
  if (!validated) {
    return <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div><p className="text-sm font-medium">Diagnóstico ainda não carregado</p><p className="mt-1 text-sm text-muted-foreground">O selo do draft representa a última validação salva. Verifique novamente para analisar o conteúdo atual.</p></div>
      {onValidate !== undefined && <Button size="sm" variant="outline" disabled={validating} onClick={onValidate}>{validating ? "Verificando…" : "Verificar agora"}</Button>}
    </div>
  }
  if (diagnostics.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <CheckCircle2Icon className="size-4 text-emerald-600" aria-hidden="true" /> Nenhum problema encontrado.
      </div>
    )
  }
  return (
    <ul className="space-y-2">
      {diagnostics.map((diagnostic, index) => {
        const Icon = diagnostic.severity === "error" ? AlertCircleIcon : AlertTriangleIcon
        return (
          <li key={`${diagnostic.code}:${index}`} className="flex gap-3 rounded-lg border p-3">
            <Icon className={diagnostic.severity === "error" ? "mt-0.5 size-4 shrink-0 text-destructive" : "mt-0.5 size-4 shrink-0 text-amber-600"} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><p className="font-medium">{diagnostic.message}</p><Badge variant={diagnostic.severity === "error" ? "destructive" : "outline"}>{diagnostic.code}</Badge></div>
              <p className="mt-1 text-xs text-muted-foreground">
                {diagnostic.resource.kind}:{diagnostic.resource.id}
                {diagnostic.file !== undefined && ` · ${pathLabel(diagnostic.file)}`}
                {diagnostic.field_path !== undefined && ` · ${diagnostic.field_path}`}
              </p>
              {diagnostic.node_id !== undefined && onOpenDiagnostic !== undefined && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => onOpenDiagnostic(diagnostic)}
                >
                  {diagnostic.node_field_path === undefined ? "Abrir passo" : "Abrir campo"}
                  <ArrowRightIcon aria-hidden="true" />
                </Button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
