import { ArrowRightIcon, DatabaseIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  workflowFieldPathLabel,
  type WorkflowSchemaField,
} from "@/features/workflows/workflow-data-mapping"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

export function WorkflowNodeDataPanel({
  node,
  sources,
  sourceFields,
  outputFields,
}: {
  node: WorkflowSourceNode
  sources: readonly WorkflowSourceNode[]
  sourceFields: ReadonlyMap<string, readonly WorkflowSchemaField[]>
  outputFields: readonly WorkflowSchemaField[]
}) {
  const mappedInputs = node.value.input !== null &&
    typeof node.value.input === "object" &&
    !Array.isArray(node.value.input)
    ? Object.keys(node.value.input).length
    : 0

  return (
    <section className="rounded-xl border bg-muted/20 p-3" aria-label="Dados de entrada e saída">
      <div className="flex items-center gap-2">
        <DatabaseIcon className="size-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-medium">Dados deste passo</h3>
        <Badge className="ml-auto" variant="outline">{mappedInputs} entrada{mappedInputs === 1 ? "" : "s"} mapeada{mappedInputs === 1 ? "" : "s"}</Badge>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-start">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Pode receber de</p>
          <div className="mt-2 flex flex-wrap gap-1">
            <Badge variant="secondary">Entrada do workflow</Badge>
            {sources.map((source) => (
              <Badge key={source.id} variant="outline" title={(sourceFields.get(source.id) ?? []).map((field) => workflowFieldPathLabel(field.path)).join(", ")}>
                {source.id} · {(sourceFields.get(source.id) ?? []).length || "dados dinâmicos"}
              </Badge>
            ))}
          </div>
        </div>
        <ArrowRightIcon className="hidden size-4 text-muted-foreground sm:mt-6 sm:block" aria-hidden="true" />
        <div>
          <p className="text-xs font-medium text-muted-foreground">Produz para os próximos</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {outputFields.length === 0 ? (
              <Badge variant="outline">Contrato dinâmico</Badge>
            ) : outputFields.slice(0, 8).map((field) => (
              <Badge key={JSON.stringify(field.path)} variant="secondary">{workflowFieldPathLabel(field.path)} · {field.valueType}</Badge>
            ))}
            {outputFields.length > 8 && <Badge variant="outline">+{outputFields.length - 8}</Badge>}
          </div>
        </div>
      </div>
    </section>
  )
}
