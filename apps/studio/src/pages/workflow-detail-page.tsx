import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeftIcon, HistoryIcon, PencilLineIcon } from "lucide-react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import { draftsQuery, studioKeys, workflowsQuery } from "@/api/queries"
import { useStudioSession } from "@/app/studio-context"
import { PageHeader } from "@/components/page-header"
import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
import { DraftStatusBadge, ModeBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { shortDigest } from "@/lib/format"

export function WorkflowDetailPage() {
  const { workflowId = "" } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useStudioSession()
  const workflows = useQuery(workflowsQuery)
  const drafts = useQuery(draftsQuery)
  const workflow = workflows.data?.workflows.find((item) => item.id === workflowId)
  const workflowDrafts = (drafts.data?.items ?? []).filter(
    (draft) => draft.primary_resource.kind === "workflow" && draft.primary_resource.id === workflowId,
  )

  const createDraft = useMutation({
    mutationFn: () => studioApi.createDraft({
      resource: { kind: "workflow", id: workflowId },
      source: { mode: "existing" },
    }),
    onSuccess: (draft) => {
      void queryClient.invalidateQueries({ queryKey: studioKeys.drafts })
      void navigate(`/drafts/${encodeURIComponent(draft.draft_id)}`)
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Falha ao criar draft"),
  })

  if (workflows.isPending || drafts.isPending) return <div className="p-6"><PageLoading /></div>
  if (workflows.isError) return <div className="p-6"><PageError error={workflows.error} /></div>
  if (drafts.isError) return <div className="p-6"><PageError error={drafts.error} retry={() => void drafts.refetch()} /></div>
  if (workflow === undefined) {
    const partial = workflows.data?.status === "partial"
    return (
      <div className="p-6">
        <PageEmpty
          title={partial ? "Workflow indisponível no catálogo parcial" : "Workflow não encontrado"}
          description={partial
            ? "Esse id não apareceu entre os workflows válidos carregados. Ele pode ter sido rejeitado; revise os diagnósticos do catálogo."
            : "O catálogo completo não contém esse id."}
          action={<Button onClick={() => void navigate("/workflows")}>Voltar</Button>}
        />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <Button variant="ghost" size="sm" className="w-fit" onClick={() => void navigate("/workflows")}>
        <ArrowLeftIcon aria-hidden="true" /> Voltar ao catálogo
      </Button>
      <PageHeader
        eyebrow="Workflow carregado"
        title={workflow.id}
        description="Esta é a projeção segura do catálogo. Abra um draft para alterar os arquivos e obter a DAG compilada."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void navigate(`/workflows/${encodeURIComponent(workflow.id)}/history`)}
            >
              <HistoryIcon aria-hidden="true" /> Histórico
            </Button>
            {workflowDrafts[0] !== undefined ? (
              <Button onClick={() => void navigate(`/drafts/${encodeURIComponent(workflowDrafts[0].draft_id)}`)}>
                <PencilLineIcon aria-hidden="true" /> Abrir draft
              </Button>
            ) : (
              <Button disabled={!session.canMutate || createDraft.isPending} onClick={() => createDraft.mutate()}>
                <PencilLineIcon aria-hidden="true" /> Criar draft
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card size="sm"><CardHeader><CardDescription>Modo</CardDescription><CardTitle><ModeBadge mode={workflow.mode} /></CardTitle></CardHeader></Card>
        <Card size="sm"><CardHeader><CardDescription>Nodes</CardDescription><CardTitle>{Object.values(workflow.node_counts).reduce((sum, count) => sum + count, 0)}</CardTitle></CardHeader></Card>
        <Card size="sm"><CardHeader><CardDescription>Concorrência máxima</CardDescription><CardTitle>{workflow.max_concurrency}</CardTitle></CardHeader></Card>
        <Card size="sm"><CardHeader><CardDescription>Revision</CardDescription><CardTitle className="font-mono">{shortDigest(workflow.revision)}</CardTitle></CardHeader></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Contratos</CardTitle><CardDescription>Referências públicas, não paths físicos expostos.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <div><p className="text-xs text-muted-foreground">Input schema</p><p className="font-mono">{workflow.input_schema}</p></div>
            <div><p className="text-xs text-muted-foreground">Output schema</p><p className="font-mono">{workflow.output_schema}</p></div>
            {workflow.config !== undefined && <div><p className="text-xs text-muted-foreground">Config</p><p className="font-mono">{workflow.config.file} · {workflow.config.schema}</p></div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Capabilities</CardTitle><CardDescription>Ids não qualificados declarados pelo workflow.</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {workflow.capabilities.map((capability) => <Badge key={capability} variant="outline">{capability}</Badge>)}
          </CardContent>
        </Card>
      </div>

      {workflowDrafts.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Drafts locais</CardTitle><CardDescription>Cada draft é um change set isolado.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {workflowDrafts.map((draft) => (
              <button
                type="button"
                key={draft.draft_id}
                onClick={() => void navigate(`/drafts/${encodeURIComponent(draft.draft_id)}`)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="font-mono text-xs">{draft.draft_id}</span>
                <DraftStatusBadge status={draft.status} />
              </button>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
