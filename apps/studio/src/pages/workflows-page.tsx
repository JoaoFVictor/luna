import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircleIcon, AlertTriangleIcon, FilePlus2Icon, NetworkIcon, PencilLineIcon, SearchIcon } from "lucide-react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import { draftsQuery, studioKeys, workflowsQuery } from "@/api/queries"
import type { WorkflowDraftCreateSource } from "@/api/types"
import { useStudioSession } from "@/app/studio-context"
import { PageHeader } from "@/components/page-header"
import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
import { DraftStatusBadge, ModeBadge } from "@/components/status-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { NewWorkflowDialog } from "@/features/workflows/new-workflow-dialog"
import { humanizeWorkflowIdentifier } from "@/features/workflows/workflow-node-catalog"
import { formatCount } from "@/lib/presentation"

function nodeTotal(counts: {
  built_in?: number
  agent?: number
  pattern?: number
  human_gate?: number
}) {
  return (counts.built_in ?? 0) + (counts.agent ?? 0) + (counts.pattern ?? 0) + (counts.human_gate ?? 0)
}

export function WorkflowsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useStudioSession()
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState("")
  const workflows = useQuery(workflowsQuery)
  const drafts = useQuery(draftsQuery)
  const newOpen = session.canMutate && params.get("new") === "1"

  const setNewOpen = (open: boolean) => {
    const next = new URLSearchParams(params)
    if (open && !session.canMutate) {
      next.delete("new")
      setParams(next, { replace: true })
      return
    }
    if (open) next.set("new", "1")
    else next.delete("new")
    setParams(next, { replace: true })
  }

  const openDraft = useMutation({
    mutationFn: ({ id, source }: { id: string; source: WorkflowDraftCreateSource }) => {
      if (!session.canMutate) {
        throw new Error("A sessão atual é somente leitura")
      }
      return studioApi.createDraft({
        resource: { kind: "workflow", id },
        source,
      })
    },
    onSuccess: (draft) => {
      void queryClient.invalidateQueries({ queryKey: studioKeys.drafts })
      setNewOpen(false)
      void navigate(`/drafts/${encodeURIComponent(draft.draft_id)}`)
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Falha ao criar draft"),
  })

  const catalogDiagnostics = workflows.data?.diagnostics ?? []

  const draftByWorkflow = useMemo(() => {
    const map = new Map<string, NonNullable<typeof drafts.data>["items"][number]>()
    for (const draft of drafts.data?.items ?? []) {
      if (draft.primary_resource.kind === "workflow" && !map.has(draft.primary_resource.id)) {
        map.set(draft.primary_resource.id, draft)
      }
    }
    return map
  }, [drafts.data])

  const filtered = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase()
    return (workflows.data?.workflows ?? []).filter(
      (workflow) =>
        normalized.length === 0 ||
        workflow.id.toLocaleLowerCase().includes(normalized) ||
        workflow.capabilities.some((capability) => capability.toLocaleLowerCase().includes(normalized)),
    )
  }, [search, workflows.data])

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Automações"
        title="Workflows"
        description="Crie, teste e acompanhe automações visuais. Os detalhes técnicos continuam disponíveis dentro de cada workflow."
        actions={
          <Button onClick={() => setNewOpen(true)} disabled={!session.canMutate}>
            <FilePlus2Icon aria-hidden="true" />
            Novo workflow
          </Button>
        }
      />

      <div className="relative max-w-md">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar workflow"
          aria-label="Buscar workflows"
          className="pl-8"
        />
      </div>

      {drafts.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Drafts indisponíveis</AlertTitle>
          <AlertDescription>
            O catálogo de workflows continua visível, mas o Studio não pode afirmar se já existe um draft para cada item. Recarregue antes de criar outro change set.
          </AlertDescription>
        </Alert>
      )}

      {workflows.data?.status === "partial" && (
        <Alert variant="destructive">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>Catálogo parcial: {formatCount(catalogDiagnostics.length, "workflow inválido", "workflows inválidos")}</AlertTitle>
          <AlertDescription>
            <p>Somente workflows aceitos pelo loader canônico aparecem na tabela. Corrija os itens abaixo antes de tratar a lista como completa.</p>
            <ul className="mt-2 space-y-1 font-mono text-xs">
              {catalogDiagnostics.slice(0, 20).map((diagnostic, index) => (
                <li key={`${diagnostic.resource_id}:${diagnostic.code}:${index}`}>
                  {diagnostic.resource_id}: {diagnostic.code} — {diagnostic.message}
                </li>
              ))}
            </ul>
            {catalogDiagnostics.length > 20 && (
              <p className="mt-2 text-xs">Mais {catalogDiagnostics.length - 20} diagnóstico(s) não exibido(s).</p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {workflows.isPending ? (
        <PageLoading label="Carregando workflows" />
      ) : workflows.isError ? (
        <PageError error={workflows.error} retry={() => void workflows.refetch()} />
      ) : filtered.length === 0 ? (
        <PageEmpty
          title={search.length > 0 ? "Nenhum workflow corresponde à busca" : "Nenhum workflow válido carregado"}
          description={search.length > 0 ? "Ajuste o filtro para procurar outro id ou capability." : workflows.data?.status === "partial" ? "Todos os candidatos podem ter sido rejeitados; revise os diagnósticos do catálogo acima." : "O catálogo seguro não retornou um workflow. Crie um draft blank e valide-o antes do apply."}
          action={session.canMutate ? <Button onClick={() => setNewOpen(true)}>Novo workflow</Button> : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>Passos</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((workflow) => {
                const draft = draftByWorkflow.get(workflow.id)
                return (
                  <TableRow key={workflow.id}>
                    <TableCell>
                      <button
                        type="button"
                        className="flex items-center gap-2 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => void navigate(`/workflows/${encodeURIComponent(workflow.id)}`)}
                      >
                        <NetworkIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                        {humanizeWorkflowIdentifier(workflow.id)}
                      </button>
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">{workflow.id}</p>
                    </TableCell>
                    <TableCell>{nodeTotal(workflow.node_counts)}</TableCell>
                    <TableCell>{draft === undefined ? <ModeBadge mode={workflow.mode} /> : <DraftStatusBadge status={draft.status} />}</TableCell>
                    <TableCell className="text-right">
                      {draft !== undefined ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void navigate(`/drafts/${encodeURIComponent(draft.draft_id)}`)}
                        >
                          <PencilLineIcon aria-hidden="true" /> Abrir draft
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!session.canMutate || openDraft.isPending || drafts.isError}
                          onClick={() => openDraft.mutate({
                            id: workflow.id,
                            source: { mode: "existing" },
                          })}
                        >
                          <PencilLineIcon aria-hidden="true" /> Editar
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <NewWorkflowDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  )
}
