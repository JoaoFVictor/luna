import { AlertTriangleIcon, ArrowRightIcon, FileCode2Icon } from "lucide-react"

import type { AgentCatalogItem, DraftTemplate } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"

function registrationLabel(
  node: DraftTemplate["graph_preview"]["nodes"][number],
  agents: Readonly<Record<string, AgentCatalogItem | undefined>>,
): string {
  if (node.registration_id !== undefined) return node.registration_id
  if (node.registration_parameter === undefined) return "registration indisponível"
  return agents[node.registration_parameter]?.id ?? `${node.registration_parameter} ainda não selecionado`
}

export function WorkflowTemplatePreview({
  template,
  workflowId,
  agents,
}: {
  template: DraftTemplate
  workflowId: string
  agents: Readonly<Record<string, AgentCatalogItem | undefined>>
}) {
  const targetDirectory = `workflows/${workflowId || "<workflow-id>"}`
  return (
    <section className="space-y-4 rounded-lg border bg-muted/20 p-4" aria-label="Preview do template">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Preview antes de criar o draft</h3>
        <Badge variant="outline">{template.classification}</Badge>
        <Badge variant="secondary">v{template.version}</Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Grafo gerado
          </h4>
          {template.graph_preview.nodes.length === 0 ? (
            <p className="text-xs text-muted-foreground">Sem nodes iniciais.</p>
          ) : (
            <ol className="space-y-1">
              {template.graph_preview.nodes.map((node) => (
                <li key={node.id} className="rounded-md border bg-background px-2 py-1.5 text-xs">
                  <span className="font-medium">{node.id}</span>
                  <span className="ml-2 font-mono text-muted-foreground">
                    {node.type} · {registrationLabel(node, agents)}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {template.graph_preview.edges.map((edge) => (
            <p key={`${edge.from}:${edge.to}`} className="mt-1 flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
              {edge.from} <ArrowRightIcon className="size-3" aria-hidden="true" /> {edge.to}
            </p>
          ))}
        </div>

        <div>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Arquivos gerados
          </h4>
          <ul className="space-y-1">
            {template.generated_files.map((file) => (
              <li key={file.relative_path} className="flex items-start gap-1.5 text-xs">
                <FileCode2Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0">
                  <code className="break-all">{targetDirectory}/{file.relative_path}</code>
                  <span className="ml-1 text-muted-foreground">({file.role})</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="space-y-2 text-xs">
        <p>
          <span className="font-medium">Capabilities:</span>{" "}
          {template.capabilities.length === 0 ? "nenhuma inicial" : template.capabilities.join(", ")}
          {Object.values(agents)
            .filter((agent): agent is AgentCatalogItem => agent !== undefined)
            .flatMap((agent) => agent.output_schema_reference.endsWith(".json")
              ? []
              : [agent.output_schema_reference.split(".", 1)[0]])
            .filter((capability, index, all) => all.indexOf(capability) === index)
            .map((capability) => `, ${capability} (output schema de agent)`)}
        </p>
        <p>
          <span className="font-medium">Config:</span>{" "}
          {template.config.required ? template.config.files.join(", ") : "não exigida"}
        </p>
        <p>
          <span className="font-medium">Runtime/provider:</span>{" "}
          {[...template.runtime_requirements, ...template.provider_requirements].join(", ") || "nenhum requisito adicional declarado"}
        </p>
        {template.reused_resources.length > 0 && (
          <p>
            <span className="font-medium">Reuso:</span>{" "}
            {template.reused_resources.map((resource) =>
              agents[resource.parameter_id]?.id ?? resource.parameter_id
            ).join(", ")}; os agents não serão clonados.
          </p>
        )}
      </div>

      {template.side_effects.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nenhum side effect externo declarado pelo template. Artifacts do runtime são bookkeeping normal.
        </p>
      ) : (
        <Alert variant="destructive">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>Side effects potenciais</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {template.side_effects.map((effect) => (
                <li key={effect.id}>
                  {effect.description} ({effect.certainty}; {effect.semantics})
                  {effect.operation_ids.length > 0 ? ` — ${effect.operation_ids.join(", ")}` : ""}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <p className="text-[11px] text-muted-foreground">
        O servidor rejeita colisões de arquivo. IDs e referências resolvidos entram no draft e no diff; uma versão futura do template nunca atualiza esta instância automaticamente.
      </p>
    </section>
  )
}
