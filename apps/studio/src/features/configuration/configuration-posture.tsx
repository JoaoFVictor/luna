import { useQuery } from "@tanstack/react-query"
import {
  BotIcon,
  BoxesIcon,
  FolderGit2Icon,
  PlugZapIcon,
  ShieldCheckIcon,
} from "lucide-react"

import {
  configurationModelsQuery,
  configurationProvidersQuery,
  configurationRepositoriesQuery,
  configurationRuntimeQuery,
} from "@/api/queries"
import { PageError, PageLoading } from "@/components/page-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export function ConfigurationPosture() {
  const models = useQuery(configurationModelsQuery)
  const repositories = useQuery(configurationRepositoriesQuery)
  const providers = useQuery(configurationProvidersQuery)
  const runtime = useQuery(configurationRuntimeQuery)
  const queries = [models, repositories, providers, runtime]

  if (queries.some((query) => query.isPending)) {
    return <PageLoading label="Carregando postura operacional" />
  }
  const failed = queries.find((query) => query.isError)
  if (failed?.isError) {
    return (
      <PageError
        error={failed.error}
        retry={() => queries.forEach((query) => void query.refetch())}
      />
    )
  }
  if (
    models.data === undefined ||
    repositories.data === undefined ||
    providers.data === undefined ||
    runtime.data === undefined
  ) {
    return <PageLoading label="Carregando postura operacional" />
  }

  return (
    <div className="space-y-4">
      <Alert>
        <ShieldCheckIcon aria-hidden="true" />
        <AlertTitle>Projeções deliberadamente read-only e redigidas</AlertTitle>
        <AlertDescription>
          Esta visão mostra ids, relacionamentos e presença. Valores de environment, credenciais, URLs esperadas, opções de runtime e paths absolutos nunca são retornados.
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BotIcon aria-hidden="true" /> Model profiles
            </CardTitle>
            <CardDescription>Consumidores e resolução de referência sem o valor do environment.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {models.data.diagnostics.map((diagnostic) => (
              <Alert
                key={diagnostic.code}
                variant={diagnostic.severity === "error" ? "destructive" : "default"}
              >
                <AlertTitle>{diagnostic.code}</AlertTitle>
                <AlertDescription>{diagnostic.message}</AlertDescription>
              </Alert>
            ))}
            {models.data.profiles.length === 0 && models.data.diagnostics.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum profile configurado.</p>
            ) : (
              models.data.profiles.map((profile) => (
                <div key={profile.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{profile.id}</span>
                    <Badge variant="outline">{profile.reasoning_effort}</Badge>
                    <Badge variant="outline">{profile.transport}</Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {profile.source.kind === "literal"
                      ? `Modelo literal: ${profile.source.model}`
                      : `${profile.source.variable}: ${profile.source.present ? "presente" : "ausente"}${profile.source.fallback_model === undefined ? "" : ` · fallback ${profile.source.fallback_model}`}`}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Agents: {profile.consumers.join(", ") || "nenhum"}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card id="repositories" className="scroll-mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FolderGit2Icon aria-hidden="true" /> Repositórios locais
            </CardTitle>
            <CardDescription>
              Checkouts disponíveis para workflows que leem ou alteram código. Os caminhos são exibidos de forma redigida.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {repositories.data.diagnostics.map((diagnostic) => (
              <Alert
                key={diagnostic.code}
                variant={diagnostic.severity === "error" ? "destructive" : "default"}
              >
                <AlertTitle>{diagnostic.code}</AlertTitle>
                <AlertDescription>{diagnostic.message}</AlertDescription>
              </Alert>
            ))}
            {repositories.data.repositories.map((repository) => (
              <div key={repository.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{repository.id}</span>
                  <Badge variant="outline">{repository.provider}</Badge>
                  <Badge variant={repository.availability === "available" ? "secondary" : "outline"}>
                    {repository.availability === "available" ? "Disponível" : "Indisponível"}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {repository.owner}/{repository.name} · {repository.path_display} · remote {repository.remote.kind === "name" ? repository.remote.name : "[redacted]"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Remotes esperados: {repository.expected_remote_count} · escrita confiável: {repository.trusted_write_readiness}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Exigido por: {repository.required_by.join(", ") || "nenhum workflow"}
                </p>
              </div>
            ))}
            <Badge variant="outline">confinement: {repositories.data.confinement_policy}</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PlugZapIcon aria-hidden="true" /> Providers
            </CardTitle>
            <CardDescription>Adapters carregados; credenciais não são inspecionadas por esta superfície.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {providers.data.providers.map((provider) => (
              <div key={provider.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{provider.id}</span>
                  <Badge variant="outline">credencial: {provider.credential_status}</Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Adapters: {provider.adapter_ids.join(", ") || "nenhum"}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BoxesIcon aria-hidden="true" /> Plugins e runtime
            </CardTitle>
            <CardDescription>Identidade da composição; options permanecem redigidas.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Workflow runtime</p>
              <p className="font-medium">{runtime.data.workflow_runtime_id}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Agent runtime</p>
              <p className="font-medium">{runtime.data.agent_runtime_id}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Workspace</p>
              <p className="font-medium">{runtime.data.workspace_strategy}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Plugins carregados</p>
              <p className="font-medium">{runtime.data.plugin_count}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
