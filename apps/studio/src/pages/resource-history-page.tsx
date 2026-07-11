import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeftIcon, GitCompareArrowsIcon, HistoryIcon } from "lucide-react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import {
  resourceHistoryCompareQuery,
  resourceHistoryQuery,
  studioKeys,
} from "@/api/queries"
import type {
  GitRevisionId,
  HistoryResource,
  ResourceHistoryRevision,
} from "@/api/types"
import { useStudioSession } from "@/app/studio-context"
import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ResourceHistoryDiff } from "@/features/history/resource-history-diff"
import { ResourceHistoryRestoreDialog } from "@/features/history/resource-history-restore-dialog"
import { formatDateTime, shortDigest } from "@/lib/format"

type HistorySelection = {
  readonly base: GitRevisionId | ""
  readonly target: GitRevisionId | ""
}

function reconcileSelection(
  current: HistorySelection,
  revisions: readonly ResourceHistoryRevision[],
): HistorySelection {
  const ids = revisions.map((revision) => revision.revision_id)
  const target = ids.includes(current.target) ? current.target : (ids[0] ?? "")
  let base = ids.includes(current.base) ? current.base : (ids[1] ?? ids[0] ?? "")
  if (base === target && ids.length > 1) {
    base = ids.find((revisionId) => revisionId !== target) ?? base
  }
  return current.base === base && current.target === target
    ? current
    : { base, target }
}

function revisionOptionLabel(revision: ResourceHistoryRevision): string {
  return `${shortDigest(revision.revision_id, 12)} · ${revision.subject}`
}

function ResourceHistoryPage({ kind }: { kind: HistoryResource["kind"] }) {
  const { resourceId = "" } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useStudioSession()
  const resource = useMemo(() => ({ kind, id: resourceId }), [kind, resourceId])
  const history = useQuery(resourceHistoryQuery(resource))
  const [selection, setSelection] = useState<HistorySelection>({
    base: "",
    target: "",
  })
  const [restoreOpen, setRestoreOpen] = useState(false)

  useEffect(() => {
    if (history.data === undefined) return
    setSelection((current) => reconcileSelection(current, history.data.revisions))
  }, [history.data])

  const comparison = useQuery(
    resourceHistoryCompareQuery(resource, selection.base, selection.target),
  )
  const selectedRevision = history.data?.revisions.find(
    (revision) => revision.revision_id === selection.target,
  )
  const restore = useMutation({
    mutationFn: () => {
      if (selection.target.length === 0) {
        throw new Error("Selecione uma revisão para restaurar")
      }
      return studioApi.restoreResourceHistory(resource, selection.target)
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: studioKeys.drafts })
      toast.success("Draft histórico criado; o projeto não foi alterado")
      const editor = result.resource.kind === "agent" ? "agent-drafts" : "drafts"
      void navigate(`/${editor}/${encodeURIComponent(result.draft.draft_id)}`)
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Falha ao criar draft histórico")
    },
  })

  const backPath = kind === "workflow"
    ? `/workflows/${encodeURIComponent(resourceId)}`
    : `/agents?selected=${encodeURIComponent(resourceId)}`
  const resourceLabel = kind === "workflow" ? "workflow" : "agent"

  if (history.isPending) {
    return <div className="p-6"><PageLoading label="Carregando histórico Git" /></div>
  }
  if (history.isError) {
    return (
      <div className="p-6">
        <PageError error={history.error} retry={() => void history.refetch()} />
      </div>
    )
  }
  if (history.data.revisions.length === 0) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
        <Button variant="ghost" size="sm" onClick={() => void navigate(backPath)}>
          <ArrowLeftIcon aria-hidden="true" /> Voltar
        </Button>
        <PageEmpty
          title="Sem histórico para este recurso"
          description={`Nenhum commit alcançável no branch atual alterou este ${resourceLabel}.`}
        />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        onClick={() => void navigate(backPath)}
      >
        <ArrowLeftIcon aria-hidden="true" /> Voltar ao {resourceLabel}
      </Button>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <HistoryIcon className="size-5 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Histórico Git do {resourceLabel}</p>
        </div>
        <h1 className="font-heading text-2xl font-semibold">{resourceId}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Apenas commits alcançáveis pelo branch atual são exibidos. Restaurar nunca
          altera Git nem o projeto diretamente: cria um draft comum para revisão.
        </p>
      </header>

      {history.data.truncated && (
        <Alert>
          <HistoryIcon aria-hidden="true" />
          <AlertTitle>Histórico limitado</AlertTitle>
          <AlertDescription>
            O servidor retornou somente as revisões mais recentes dentro do limite seguro.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Comparar revisões</CardTitle>
          <CardDescription>
            Escolha qualquer par retornado pelo servidor. O diff textual sempre passa
            pela redação canônica de conteúdo sensível.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-2 text-sm font-medium" htmlFor="history-base">
            Revisão base
            <NativeSelect
              id="history-base"
              className="w-full"
              value={selection.base}
              onChange={(event) => setSelection((current) => ({
                ...current,
                base: event.target.value,
              }))}
            >
              {history.data.revisions.map((revision) => (
                <NativeSelectOption
                  key={revision.revision_id}
                  value={revision.revision_id}
                >
                  {revisionOptionLabel(revision)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label className="grid gap-2 text-sm font-medium" htmlFor="history-target">
            Revisão alvo
            <NativeSelect
              id="history-target"
              className="w-full"
              value={selection.target}
              onChange={(event) => setSelection((current) => ({
                ...current,
                target: event.target.value,
              }))}
            >
              {history.data.revisions.map((revision) => (
                <NativeSelectOption
                  key={revision.revision_id}
                  value={revision.revision_id}
                >
                  {revisionOptionLabel(revision)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <div className="flex flex-wrap items-center gap-2 md:col-span-2">
            <Button
              disabled={!session.canMutate || selectedRevision === undefined}
              onClick={() => setRestoreOpen(true)}
            >
              <HistoryIcon aria-hidden="true" /> Criar draft da revisão alvo
            </Button>
            {!session.canMutate && (
              <span className="text-xs text-muted-foreground">
                Reabra a URL de inicialização para criar drafts.
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3" aria-labelledby="history-revisions-title">
        <h2 id="history-revisions-title" className="font-heading text-lg font-semibold">
          Revisões do recurso
        </h2>
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Commit</TableHead>
                <TableHead>Data</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead>Seleção</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.data.revisions.map((revision) => (
                <TableRow key={revision.revision_id}>
                  <TableCell className="font-mono text-xs">
                    {shortDigest(revision.revision_id, 12)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatDateTime(revision.committed_at)}
                  </TableCell>
                  <TableCell>{revision.subject}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {selection.base === revision.revision_id && (
                        <Badge variant="outline">Base</Badge>
                      )}
                      {selection.target === revision.revision_id && (
                        <Badge>Alvo</Badge>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="history-diff-title">
        <div className="flex items-center gap-2">
          <GitCompareArrowsIcon className="size-5 text-muted-foreground" aria-hidden="true" />
          <h2 id="history-diff-title" className="font-heading text-lg font-semibold">
            Diff seguro
          </h2>
        </div>
        {selection.base === selection.target ? (
          <p className="text-sm text-muted-foreground">
            Escolha duas revisões diferentes para comparar.
          </p>
        ) : comparison.isPending ? (
          <PageLoading label="Comparando revisões" />
        ) : comparison.isError ? (
          <PageError error={comparison.error} retry={() => void comparison.refetch()} />
        ) : (
          <ResourceHistoryDiff comparison={comparison.data} />
        )}
      </section>

      <ResourceHistoryRestoreDialog
        open={restoreOpen}
        pending={restore.isPending}
        revision={selectedRevision}
        onOpenChange={setRestoreOpen}
        onConfirm={() => restore.mutate()}
      />
    </div>
  )
}

export function WorkflowResourceHistoryPage() {
  return <ResourceHistoryPage kind="workflow" />
}

export function AgentResourceHistoryPage() {
  return <ResourceHistoryPage kind="agent" />
}
