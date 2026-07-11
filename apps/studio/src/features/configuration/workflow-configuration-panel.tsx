import { useState } from "react"
import {
  FileCheck2Icon,
  RefreshCwIcon,
  SaveIcon,
  SearchIcon,
  ShieldAlertIcon,
} from "lucide-react"
import { useStudioSession } from "@/app/studio-context"
import { PageError, PageLoading } from "@/components/page-state"
import { DraftStatusBadge } from "@/components/status-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ConfigurationFieldEditor } from "./configuration-field-editor"
import { useWorkflowConfigurationController } from "./use-workflow-configuration-controller"
import { WorkflowConfigurationPlan } from "./workflow-configuration-plan"

function fieldPath(path: readonly string[]): string {
  return path.join(".")
}

function humanizeSegment(value: string): string {
  const words = value.replaceAll(/[_-]+/g, " ")
  return words.charAt(0).toLocaleUpperCase() + words.slice(1)
}

export function WorkflowConfigurationPanel({
  workflowId,
  initialDraftId,
}: {
  workflowId: string
  initialDraftId?: string
}) {
  const session = useStudioSession()
  const [search, setSearch] = useState("")
  const controller = useWorkflowConfigurationController(workflowId, initialDraftId)
  const {
    installed,
    initialDraft,
    draft,
    plan,
    confirmApply,
    setConfirmApply,
    setPendingUpdates,
    pendingUpdateList,
    createDraft,
    patchDraft,
    validateDraft,
    planApply,
    applyDraft,
    mutationPending,
  } = controller

  if (installed.isPending) return <PageLoading label="Carregando configuração" />
  if (installed.isError) {
    return <PageError error={installed.error} retry={() => void installed.refetch()} />
  }
  if (initialDraftId !== undefined && initialDraft.isPending) {
    return <PageLoading label="Carregando draft de configuração" />
  }
  if (initialDraftId !== undefined && initialDraft.isError) {
    return <PageError error={initialDraft.error} retry={() => void initialDraft.refetch()} />
  }

  const configuration = controller.configuration
  if (configuration === undefined) return <PageLoading label="Carregando configuração" />
  const searchTerm = search.trim().toLocaleLowerCase()
  const visibleFields = configuration.fields.filter((field) =>
    searchTerm.length === 0 ||
    field.path.some((segment) => segment.toLocaleLowerCase().includes(searchTerm)) ||
    field.title?.toLocaleLowerCase().includes(searchTerm) === true ||
    field.description?.toLocaleLowerCase().includes(searchTerm) === true,
  )
  const fieldGroups = visibleFields.reduce<Record<string, typeof configuration.fields>>((groups, field) => {
    const group = (field.path.length >= 3 ? field.path[1] : field.path[0]) ?? "geral"
    groups[group] = [...(groups[group] ?? []), field]
    return groups
  }, {})

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Configurações de {workflowId}</CardTitle>
                <CardDescription>
                  Altere os valores relacionados e salve tudo de uma vez.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={configuration.status === "ready" ? "secondary" : "outline"}>
                  {configuration.status === "ready" ? "Pronta" : configuration.status === "not_declared" ? "Não configurada" : "Com problemas"}
                </Badge>
                {draft !== undefined && <DraftStatusBadge status={draft.status} />}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {configuration.fields.length > 8 && (
              <div className="space-y-2">
                <div className="relative max-w-md">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-8" placeholder="Buscar configuração" aria-label="Buscar configurações" />
                </div>
                <nav className="flex flex-wrap gap-1" aria-label="Seções da configuração">
                  {Object.keys(fieldGroups).map((group) => (
                    <a key={group} href={`#config-${group}`} className="rounded-md border px-2 py-1 text-xs hover:bg-muted">
                      {humanizeSegment(group)}
                    </a>
                  ))}
                </nav>
              </div>
            )}
            <details className="rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">Resumo técnico</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground">Classificados</p>
                <p className="mt-1 text-xl font-semibold">
                  {configuration.schema_summary.classified_field_count}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground">Não classificados</p>
                <p className="mt-1 text-xl font-semibold">
                  {configuration.schema_summary.unclassified_field_count}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground">Referências $.config</p>
                <p className="mt-1 text-xl font-semibold">{configuration.references.length}</p>
              </div>
            </div></details>

            {configuration.diagnostics.map((diagnostic, index) => (
              <Alert key={`${diagnostic.code}:${index}`} variant={diagnostic.severity === "error" ? "destructive" : "default"}>
                <ShieldAlertIcon aria-hidden="true" />
                <AlertTitle>{diagnostic.code}</AlertTitle>
                <AlertDescription>{diagnostic.message}</AlertDescription>
              </Alert>
            ))}

            {configuration.status === "not_declared" ? (
              <Alert>
                <AlertTitle>Este workflow não declara config</AlertTitle>
                <AlertDescription>
                  Adicione config.file e config.schema ao workflow antes de criar um draft de valores.
                </AlertDescription>
              </Alert>
            ) : configuration.fields.length === 0 ? (
              <Alert>
                <AlertTitle>Nenhum valor autorizado para o navegador</AlertTitle>
                <AlertDescription>
                  O schema existe, mas nenhum leaf possui metadata x-luna-studio válida. Os valores continuam somente no servidor.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-6">
                {Object.entries(fieldGroups).map(([group, fields]) => (
                  <section key={group} id={`config-${group}`} className="scroll-mt-6 space-y-3">
                    <div>
                      <h3 className="font-medium">{humanizeSegment(group)}</h3>
                      <p className="text-xs text-muted-foreground">{fields.length} {fields.length === 1 ? "configuração" : "configurações"}</p>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      {fields.map((field) => (
                        <ConfigurationFieldEditor
                          key={field.expression}
                          field={field}
                          canMutate={session.canMutate && draft !== undefined}
                          pending={mutationPending}
                          onChange={(path, value) => {
                            const key = fieldPath(path)
                            setPendingUpdates((current) => {
                              const next = { ...current }
                              if (value === undefined || JSON.stringify(value) === JSON.stringify(field.value)) delete next[key]
                              else next[key] = { path, value }
                              return next
                            })
                          }}
                        />
                      ))}
                    </div>
                  </section>
                ))}
                {visibleFields.length === 0 && (
                  <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    Nenhuma configuração corresponde à busca.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Alterações</CardTitle>
              <CardDescription>
                Salve, revise e aplique quando estiver pronto.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {draft === undefined ? (
                <Button
                  className="w-full"
                  disabled={
                    !session.canMutate ||
                    configuration.status !== "ready" ||
                    createDraft.isPending
                  }
                  onClick={() => createDraft.mutate()}
                >
                  <SaveIcon aria-hidden="true" />
                  {createDraft.isPending ? "Preparando…" : "Começar a editar"}
                </Button>
              ) : (
                <>
                  <Button
                    className="w-full"
                    disabled={mutationPending || pendingUpdateList.length === 0}
                    onClick={() => patchDraft.mutate(pendingUpdateList)}
                  >
                    <SaveIcon aria-hidden="true" />
                    {patchDraft.isPending ? "Salvando…" : `Salvar alterações${pendingUpdateList.length > 0 ? ` (${pendingUpdateList.length})` : ""}`}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={mutationPending || pendingUpdateList.length > 0}
                    onClick={() => validateDraft.mutate()}
                  >
                    <FileCheck2Icon aria-hidden="true" />
                    {validateDraft.isPending ? "Verificando…" : "Verificar alterações"}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={mutationPending || pendingUpdateList.length > 0 || draft.status !== "valid"}
                    onClick={() => planApply.mutate()}
                  >
                    <RefreshCwIcon aria-hidden="true" />
                    {planApply.isPending ? "Preparando…" : "Revisar e aplicar"}
                  </Button>
                </>
              )}
              {!session.canMutate && (
                <p className="text-xs text-muted-foreground">
                  Sessão read-only: reabra a URL de inicialização para editar.
                </p>
              )}
            </CardContent>
          </Card>

          <details className="rounded-xl border bg-card p-4">
            <summary className="cursor-pointer font-medium">Referências técnicas</summary>
          <Card className="mt-3 border-0 shadow-none">
            <CardHeader>
              <CardTitle>Referências</CardTitle>
              <CardDescription>Expressions encontradas na definição do workflow.</CardDescription>
            </CardHeader>
            <CardContent>
              {configuration.references.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhuma referência encontrada.</p>
              ) : (
                <ul className="space-y-2">
                  {configuration.references.map((reference) => (
                    <li key={reference.expression}>
                      <code className="block overflow-x-auto rounded bg-muted px-2 py-1 text-xs">
                        {reference.expression}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card></details>
        </div>
      </div>

      {plan !== undefined && <WorkflowConfigurationPlan plan={plan} mutationPending={mutationPending} draftExists={draft !== undefined} onConfirm={() => setConfirmApply(true)} />}

      <AlertDialog open={confirmApply} onOpenChange={setConfirmApply}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Aplicar configuração de {workflowId}?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta operação grava somente o arquivo de config autorizado. Não faz commit, push ou reload remoto.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={applyDraft.isPending}
              onClick={() => applyDraft.mutate()}
            >
              {applyDraft.isPending ? "Aplicando…" : "Aplicar configuração"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
