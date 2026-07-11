import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  CableIcon,
  InfoIcon,
  RouteIcon,
  Settings2Icon,
  ShieldCheckIcon,
} from "lucide-react"
import { Link, useSearchParams } from "react-router-dom"

import { inputAdaptersQuery, routingQuery, workflowsQuery } from "@/api/queries"
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
import { WorkflowConfigurationPanel } from "@/features/configuration/workflow-configuration-panel"

export function ConfigurationPage() {
  const [searchParams] = useSearchParams()
  const requestedWorkflowId = searchParams.get("workflow") ?? ""
  const requestedDraftId = searchParams.get("draft") ?? undefined
  const workflows = useQuery(workflowsQuery)
  const adapters = useQuery(inputAdaptersQuery)
  const routing = useQuery(routingQuery)
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
        eyebrow="Configuração segura"
        title="Configuration"
        description="Edite valores de workflow explicitamente classificados, revise o diff seguro e inspecione a postura operacional redigida. Secrets, raw env e auth files ficam fora da Control API."
      />
      <Alert>
        <InfoIcon aria-hidden="true" />
        <AlertTitle>Adapter e workflow são responsabilidades diferentes</AlertTitle>
        <AlertDescription>
          O adapter normaliza a entrada em uma invocation. O router avalia regras determinísticas em ordem e escolhe o workflow. O workflow não declara “vim do adapter X”.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="workflow">
        <TabsList className="flex h-auto flex-wrap">
          <TabsTrigger value="workflow">
            <Settings2Icon aria-hidden="true" /> Workflow config
          </TabsTrigger>
          <TabsTrigger value="routing">
            <RouteIcon aria-hidden="true" /> Routing
          </TabsTrigger>
          <TabsTrigger value="adapters">
            <CableIcon aria-hidden="true" /> Input adapters
          </TabsTrigger>
          <TabsTrigger value="posture">
            <ShieldCheckIcon aria-hidden="true" /> Postura operacional
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
                      O form é derivado do schema do workflow selecionado.
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
            <Card>
              <CardHeader>
                <CardTitle>Regras first-match</CardTitle>
                <CardDescription>
                  Version {routing.data.version}. A ordem é semântica e nunca usa decisão de modelo.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Link className={buttonVariants({ variant: "outline" })} to="/launch">
                  <RouteIcon aria-hidden="true" /> Simular com adapter e string opaca
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
                      <p className="font-medium">{rule.id}</p>
                      <code className="mt-1 block overflow-x-auto text-xs text-muted-foreground">
                        {rule.when.expression}
                      </code>
                    </div>
                    <Badge variant="outline">{rule.target}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="adapters" className="pt-4">
          {adapters.isPending ? (
            <PageLoading label="Carregando adapters" />
          ) : adapters.isError ? (
            <PageError error={adapters.error} retry={() => void adapters.refetch()} />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {adapters.data.adapters.map((adapter) => (
                <Card key={adapter.id}>
                  <CardHeader>
                    <CardTitle>{adapter.id}</CardTitle>
                    <CardDescription>{adapter.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="flex gap-2">
                      <Badge variant="outline">source: {adapter.source}</Badge>
                      <Badge variant="outline">CLI string</Badge>
                    </div>
                    <p className="text-muted-foreground">
                      Preview: {adapter.preview.enabled
                        ? `habilitado · ${adapter.preview.effects.join(", ") || "sem efeitos declarados"}`
                        : "indisponível neste adapter"}
                    </p>
                  </CardContent>
                </Card>
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
