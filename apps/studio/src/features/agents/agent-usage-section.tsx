import { AlertTriangleIcon, ExternalLinkIcon, GitBranchIcon, ShieldCheckIcon } from "lucide-react"
import { Link } from "react-router-dom"

import type { AgentCatalog, AgentCatalogItem, WorkflowCatalog, WorkflowSummary } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { AgentDefinitionView } from "@/features/agents/agent-definition-model"
import { shortDigest } from "@/lib/format"

function SummaryList({ label, values }: { label: string; values: readonly string[] }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex flex-wrap gap-1">
        {values.length === 0
          ? <span className="text-xs text-muted-foreground">nenhum</span>
          : values.map((value, index) => <Badge key={`${index}:${value}`} variant="outline" className="max-w-full break-all">{value}</Badge>)}
      </dd>
    </div>
  )
}

export function AgentUsageSection({
  agent,
  workflows,
  agents,
  agentsCatalogStatus,
  workflowsCatalogStatus,
}: {
  agent: AgentDefinitionView
  workflows: readonly WorkflowSummary[]
  agents: readonly AgentCatalogItem[]
  agentsCatalogStatus: AgentCatalog["status"]
  workflowsCatalogStatus: WorkflowCatalog["status"]
}) {
  const subagents = agent.subagents.map((subagent) =>
    typeof subagent === "string" ? subagent : JSON.stringify(subagent)
  )
  const parentAgents = agents.filter((candidate) =>
    candidate.id !== agent.id &&
    candidate.subagents.some((subagent) => subagent.id === agent.id)
  )
  const impactIsPartial =
    agentsCatalogStatus === "partial" || workflowsCatalogStatus === "partial"
  return (
    <div className="space-y-4">
      <Alert variant={impactIsPartial ? "destructive" : "default"}>
        {impactIsPartial
          ? <AlertTriangleIcon aria-hidden="true" />
          : <ShieldCheckIcon aria-hidden="true" />}
        <AlertTitle>{impactIsPartial ? "Impacto incompleto: catálogo parcial" : "Impacto é calculado pelo catálogo carregado"}</AlertTitle>
        <AlertDescription>
          {impactIsPartial
            ? `A busca reversa não inclui recursos rejeitados pelo loader${agentsCatalogStatus === "partial" ? "; o catálogo de agents está parcial" : ""}${workflowsCatalogStatus === "partial" ? "; o catálogo de workflows está parcial" : ""}. Ausência nesta lista não prova que não existe consumidor.`
            : "Esta visão inclui referências em nodes, workers de pattern e gates reconhecidas pelo loader. Drafts de workflow ainda não aplicados não aparecem aqui."}
        </AlertDescription>
      </Alert>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.6fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><GitBranchIcon className="size-4" aria-hidden="true" /> Workflows consumidores</CardTitle>
              <CardDescription>Alterar instructions, output schema, mode ou resources pode mudar estes consumidores.</CardDescription>
            </CardHeader>
            <CardContent>
              {workflows.length === 0 ? (
                <p className="text-sm text-muted-foreground">{workflowsCatalogStatus === "partial" ? "Nenhum workflow carregado referencia este agent; o catálogo parcial impede afirmar que não há consumidor." : "Nenhum workflow ativo referencia este agent."}</p>
              ) : (
                <ul className="space-y-2">
                  {workflows.map((workflow) => (
                    <li key={workflow.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                      <div>
                        <p className="font-medium">{workflow.id}</p>
                        <p className="font-mono text-xs text-muted-foreground">revision {shortDigest(workflow.revision)}</p>
                      </div>
                      <Link className={buttonVariants({ size: "sm", variant: "outline" })} to={`/workflows/${encodeURIComponent(workflow.id)}`}>Abrir <ExternalLinkIcon aria-hidden="true" /></Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Agents consumidores via subagent</CardTitle>
              <CardDescription>Referências do catálogo ativo; drafts ainda não aplicados não entram nesta lista.</CardDescription>
            </CardHeader>
            <CardContent>
              {parentAgents.length === 0 ? (
                <p className="text-sm text-muted-foreground">{agentsCatalogStatus === "partial" ? "Nenhum agent carregado usa este agent como subagent; o catálogo parcial impede afirmar que não há consumidor." : "Nenhum agent ativo usa este agent como subagent."}</p>
              ) : (
                <ul className="space-y-2">
                  {parentAgents.map((parent) => (
                    <li key={parent.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                      <div>
                        <p className="font-medium">{parent.id}</p>
                        <p className="text-xs text-muted-foreground">{parent.description}</p>
                      </div>
                      <Link className={buttonVariants({ size: "sm", variant: "outline" })} to={`/agents?selected=${encodeURIComponent(parent.id)}`}>Inspecionar <ExternalLinkIcon aria-hidden="true" /></Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader><CardTitle>Contrato declarado</CardTitle><CardDescription>Resumo auditável; não representa uma execução.</CardDescription></CardHeader>
          <CardContent>
            <dl className="space-y-4">
              <SummaryList label="Perfil de modelo" values={[agent.modelProfile]} />
              <SummaryList
                label="Modo"
                values={[agent.modeIsKnown ? agent.mode : "inválido (tools fail-closed como read_only)"]}
              />
              <SummaryList label="Schema de saída" values={[agent.outputSchema]} />
              <SummaryList label="Ferramentas" values={agent.tools} />
              <SummaryList label="Servidores MCP" values={agent.mcpServers} />
              <SummaryList label="Subagentes" values={subagents} />
              <SummaryList label="Skills" values={agent.skills} />
              <SummaryList label="Arquivos de contexto" values={agent.contextFiles} />
              <SummaryList label="Requisitos de runtime" values={agent.runtimeRequirements} />
              <SummaryList label="Runtime preferido" values={agent.preferredRuntime.length === 0 ? [] : [agent.preferredRuntime]} />
              <SummaryList label="Ordem de runtime" values={agent.runtimeOrder} />
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
