import { useEffect, useRef, type ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import {
  workflowInspectorFieldDiagnostics,
  type WorkflowInspectorField,
  type WorkflowNodeDiagnostic,
} from "@/features/workflows/workflow-node-diagnostics"
import { cn } from "@/lib/utils"

export function WorkflowInspectorDiagnosticField({
  field,
  diagnostics,
  focused,
  children,
}: {
  field: WorkflowInspectorField
  diagnostics: readonly WorkflowNodeDiagnostic[]
  focused: boolean
  children: ReactNode
}) {
  const container = useRef<HTMLDivElement>(null)
  const fieldDiagnostics = workflowInspectorFieldDiagnostics(diagnostics, field)
  const hasError = fieldDiagnostics.some((diagnostic) => diagnostic.severity === "error")

  useEffect(() => {
    if (!focused) return
    if (typeof container.current?.scrollIntoView === "function") {
      container.current.scrollIntoView({ behavior: "smooth", block: "center" })
    }
    container.current?.focus({ preventScroll: true })
  }, [focused])

  return (
    <div
      ref={container}
      tabIndex={-1}
      data-workflow-inspector-field={field}
      aria-invalid={hasError || undefined}
      className={cn(
        "rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        hasError && "ring-1 ring-destructive/40",
      )}
    >
      {children}
      {fieldDiagnostics.length > 0 && (
        <ul className="mt-2 space-y-1 rounded-md bg-destructive/5 p-2 text-xs" aria-label={`Problemas no campo ${field}`}>
          {fieldDiagnostics.map((diagnostic) => (
            <li key={`${diagnostic.code}:${diagnostic.message}`} className="flex items-start gap-2">
              <Badge variant={diagnostic.severity === "error" ? "destructive" : "outline"}>
                {diagnostic.severity === "error" ? "Erro" : "Aviso"}
              </Badge>
              <span>{diagnostic.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
