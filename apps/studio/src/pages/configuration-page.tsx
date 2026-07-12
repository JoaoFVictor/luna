import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  CableIcon,
  RouteIcon,
  Settings2Icon,
  ShieldCheckIcon,
} from "lucide-react"
import { Link, useSearchParams } from "react-router-dom"

import { configurationProvidersQuery, inputAdaptersQuery, routingQuery, workflowsQuery } from "@/api/queries"
import { PageHeader } from "@/components/page-header"
import { PageError, PageLoading } from "@/components/page-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ConfigurationPosture } from "@/features/configuration/configuration-posture"
import { RoutingEditor } from "@/features/configuration/routing-editor"
import { routingRuleDescription, routingTargetLabel } from "@/features/configuration/routing-presentation"
import { WorkflowConfigurationPanel } from "@/features/configuration/workflow-configuration-panel"
import { ProviderConnectionCard } from "@/features/configuration/provider-connection-card"

export function ConfigurationPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedWorkflowId = searchParams.get("workflow") ?? ""
  const requestedDraftId = searchParams.get("draft") ?? undefined
  const workflows = useQuery(workflowsQuery)
  const adapters = useQuery(inputAdaptersQuery)
  const routing = useQuery(routingQuery)
  const providers = useQuery(configurationProvidersQuery)
  const requestedTab = searchParams.get("tab")
  const activeTab = requestedTab === "routing" || requestedTab === "adapters" || requestedTab === "posture"
    ? requestedTab
    : "workflow"
  const configurableWorkflows = useMemo(
    () => workflows.data?.workflows.filter((workflow) => workflow.config !== undefined) ?? [],
    [workflows.data],
  )
  const [workflowId, setWorkflowId] = useState(requestedWorkflowId)

  useEffect(() => {
    if (
      requestedWorkflowId !== "" &&
      configurableWorkflows.some((workflow) => workflow.id === requestedWorkflowId)
    ) {
      setWorkflowId(requestedWorkflowId)
    }
  }, [configurableWorkflows, requestedWorkflowId])

  useEffect(() => {
    if (
      configurableWorkflows.length > 0 &&
      !configurableWorkflows.some((workflow) => workflow.id === workflowId)
    ) {
      setWorkflowId(configurableWorkflows[0].id)
    }
  }, [configurableWorkflows, workflowId])

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Entradas e comportamento"
        title="Conexões"
        description="Configure cada workflow, confira as entradas disponíveis e veja como uma solicitação escolhe o fluxo certo."
      />

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams)
          if (value === "workflow") next.delete("tab")
          else next.set("tab", value)
          setSearchParams(next, { replace: true })
        }}
      >
        <TabsList className="flex h-auto flex-wrap">
          <TabsTrigger value="workflow">
            <Settings2Icon aria-hidden="true" /> Workflows
          </TabsTrigger>
          <TabsTrigger value="routing">
            <RouteIcon aria-hidden="true" /> Regras de entrada
          </TabsTrigger>
          <TabsTrigger value="adapters">
            <CableIcon aria-hidden="true" /> Entradas
          </TabsTrigger>
          <TabsTrigger value="posture">
            <ShieldCheckIcon aria-hidden="true" /> Segurança técnica
          </TabsTrigger>
        </TabsList>

        <TabsContent value="workflow" className="space-y-4 pt-4">
          {workflows.isPending ? (
            <PageLoading label="Carregando workflows configuráveis" />
          ) : workflows.isError ? (
            <PageError error={workflows.error} retry={() => void workflows.refetch()} />
          ) : configurableWorkflows.length === 0 ? (
            <Alert>
              <AlertTitle>
                {workflows.data.status === "partial"
                  ? "Nenhum workflow configurável entre os itens carregados"
                  : "Nenhum workflow declara config"}
              </AlertTitle>
              <AlertDescription>
                {workflows.data.status === "partial"
                  ? "O catálogo está parcial; outros workflows podem ter sido rejeitados. Revise os diagnósticos antes de concluir que não há configuração declarada."
                  : "Um workflow precisa declarar config.file e config.schema para aparecer aqui."}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <Card>
                <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">Workflow</p>
                    <p className="text-xs text-muted-foreground">
                      Ajuste os valores usados quando este workflow executar.
                    </p>
                  </div>
                  <NativeSelect
                    className="w-full sm:w-80"
                    value={workflowId}
                    onChange={(event) => setWorkflowId(event.target.value)}
                    aria-label="Workflow configurável"
                  >
                    {configurableWorkflows.map((workflow) => (
                      <NativeSelectOption key={workflow.id} value={workflow.id}>
                        {workflow.id} · {workflow.mode}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </CardContent>
              </Card>
              {workflowId !== "" && (
                <WorkflowConfigurationPanel
                  key={workflowId}
                  workflowId={workflowId}
                  initialDraftId={workflowId === requestedWorkflowId ? requestedDraftId : undefined}
                />
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="routing" className="pt-4">
          {routing.isPending ? (
            <PageLoading label="Carregando routing" />
          ) : routing.isError ? (
            <PageError error={routing.error} retry={() => void routing.refetch()} />
          ) : (
            <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Qual workflow será escolhido?</CardTitle>
                <CardDescription>
                  As regras são verificadas de cima para baixo. A primeira que combinar define o workflow.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Link className={buttonVariants({ variant: "outline" })} to="/launch">
                  <RouteIcon aria-hidden="true" /> Testar uma entrada
                </Link>
                {routing.data.rules.map((rule, index) => (
                  <div
                    key={rule.id}
                    className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[2rem_1fr_auto] sm:items-start"
                  >
                    <span className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-medium">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium">{routingRuleDescription(rule)}</p>
                      <p className="text-xs text-muted-foreground">Regra {index + 1} · a ordem é determinística</p>
                      <details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">Ver condição técnica</summary><code className="mt-1 block overflow-x-auto text-xs text-muted-foreground">{rule.when.expression}</code></details>
                    </div>
                    <Badge variant="outline">{routingTargetLabel(rule.target)}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
            <RoutingEditor workflowIds={workflows.data?.workflows.map((workflow) => workflow.id) ?? []} />
            </div>
          )}
        </TabsContent>

        <TabsContent value="adapters" className="pt-4">
          {adapters.isPending || providers.isPending ? (
            <PageLoading label="Carregando entradas e conexões" />
          ) : adapters.isError ? (
            <PageError error={adapters.error} retry={() => void adapters.refetch()} />
          ) : providers.isError ? (
            <PageError error={providers.error} retry={() => void providers.refetch()} />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {providers.data.providers.map((provider) => (
                <ProviderConnectionCard
                  key={provider.id}
                  provider={provider}
                  adapters={adapters.data.adapters.filter((adapter) => adapter.source === provider.id)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="posture" className="pt-4">
          <ConfigurationPosture />
        </TabsContent>
      </Tabs>
    </div>
  )
}
