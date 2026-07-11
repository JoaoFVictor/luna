import { useCallback, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeftIcon, CheckCircle2Icon, FileDiffIcon, LoaderCircleIcon, PlayIcon, Settings2Icon, Trash2Icon } from "lucide-react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import {
  agentsQuery,
  configurationModelsQuery,
  configurationRuntimeQuery,
  draftQuery,
  draftSourceViewQuery,
  libraryQuery,
  studioKeys,
  workflowsQuery,
} from "@/api/queries"
import type {
  DraftFile,
  DraftItem,
  DraftValidationResult,
  StudioPath,
  YamlSourceOperation,
} from "@/api/types"
import { useStudioSession } from "@/app/studio-context"
import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  draftFileWriteEdits,
  type DraftFileSessionSnapshot,
} from "@/features/drafts/draft-file-session"
import { useDraftFileSession } from "@/features/drafts/use-draft-file-session"
import { useDraftNavigationGuard } from "@/features/drafts/use-draft-navigation-guard"
import { ApplyPlanDialog } from "@/features/workflows/apply-plan-dialog"
import { DraftFilesEditor } from "@/features/workflows/draft-files-editor"
import { ProblemsPanel } from "@/features/workflows/problems-panel"
import { AgentDraftTestBench } from "@/features/agents/agent-draft-test-bench"
import { agentSideEffectPreview } from "@/features/agents/agent-side-effect-preview"
import { AgentStructuredEditor } from "@/features/agents/agent-structured-editor"
import { useAgentEditorAutomation } from "@/features/agents/use-agent-editor-automation"
import { useAgentApplyActions } from "@/features/agents/use-agent-apply-actions"
import { authoringAuthorityUnavailable } from "@/features/drafts/authoring-authority"
import { formatDateTime, shortDigest } from "@/lib/format"

export function AgentEditorPage() {
  const { draftId = "" } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useStudioSession()
  const draft = useQuery(draftQuery(draftId))
  const agentFile: StudioPath = {
    root: "project",
    path: `agents/${draft.data?.primary_resource.id ?? "pending"}/agent.yaml`,
  }
  const sourceView = useQuery({
    ...draftSourceViewQuery(draftId, agentFile),
    enabled: draft.data?.primary_resource.kind === "agent",
  })
  const workflows = useQuery(workflowsQuery)
  const agents = useQuery(agentsQuery)
  const library = useQuery(libraryQuery)
  const models = useQuery(configurationModelsQuery)
  const runtime = useQuery(configurationRuntimeQuery)
  const files = useDraftFileSession(draft.data)
  const [validation, setValidation] = useState<DraftValidationResult>()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [structuredLocalChanges, setStructuredLocalChanges] = useState(false)
  const [activeView, setActiveView] = useState("studio")
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const hasLocalChanges = files.hasLocalChanges || structuredLocalChanges
  const navigationBlocker = useDraftNavigationGuard(hasLocalChanges)
  const applyActions = useAgentApplyActions({
    draftId,
    draft: draft.data,
    refetchDraft: draft.refetch,
  })
  const { plan, setPlan, planOpen, setPlanOpen, applyResult, setApplyResult, planApply, apply, remove } = applyActions

  const publishDraft = useCallback(
    (next: DraftItem, snapshot: DraftFileSessionSnapshot) => {
      files.acceptServerDraft(next, snapshot)
      queryClient.setQueryData<DraftItem>(studioKeys.draft(next.draft_id), (current) =>
        current !== undefined && current.record_revision > next.record_revision
          ? current
          : next,
      )
      void queryClient.invalidateQueries({ queryKey: studioKeys.drafts })
    },
    [files, queryClient],
  )

  const withSnapshot = useCallback(
    (operation: (snapshot: DraftFileSessionSnapshot) => void) => {
      const snapshot = files.captureSnapshot()
      if (snapshot === undefined) {
        toast.error("A sessão de arquivos ainda não está pronta")
        return
      }
      operation(snapshot)
    },
    [files],
  )

  const save = useMutation({
    mutationFn: (snapshot: DraftFileSessionSnapshot) => {
      const edits = draftFileWriteEdits(snapshot)
      if (edits.length === 0) throw new Error("Não há alterações locais para salvar")
      return studioApi.patchDraft(snapshot.draftId, snapshot.serverEtag, edits)
    },
    onSuccess: async (next, snapshot) => {
      publishDraft(next, snapshot)
      await queryClient.invalidateQueries({
        queryKey: studioKeys.draftSourceView(draftId, agentFile),
      })
      setValidation(undefined)
      setPlan(undefined)
      setApplyResult(undefined)
      toast.success("Draft do agent salvo")
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Falha ao salvar"),
  })

  const structuredEdit = useMutation({
    mutationFn: ({
      snapshot,
      operations,
    }: {
      snapshot: DraftFileSessionSnapshot
      operations: readonly YamlSourceOperation[]
    }) => studioApi.editDraftSource(
      snapshot.draftId,
      snapshot.serverEtag,
      agentFile,
      operations,
    ),
    onSuccess: async (next, { snapshot }) => {
      const current = files.operationResponseIsCurrent(next, snapshot)
      publishDraft(next, snapshot)
      await queryClient.invalidateQueries({
        queryKey: studioKeys.draftSourceView(draftId, agentFile),
      })
      setValidation(undefined)
      setPlan(undefined)
      setApplyResult(undefined)
      if (!current) {
        toast.warning("O draft mudou durante a edição estruturada; o texto local foi preservado")
        return
      }
      toast.success("Campo estruturado salvo no draft")
    },
    onError: (error) => toast.error(
      error instanceof Error ? error.message : "Falha na edição estruturada",
    ),
  })

  const structuredFileWrite = useMutation({
    mutationFn: ({
      snapshot,
      file,
      content,
    }: {
      snapshot: DraftFileSessionSnapshot
      file: DraftFile
      content: string
    }) => studioApi.patchDraft(snapshot.draftId, snapshot.serverEtag, [{
      action: "write",
      file: file.file,
      content,
    }]),
    onSuccess: async (next, { snapshot }) => {
      const current = files.operationResponseIsCurrent(next, snapshot)
      publishDraft(next, snapshot)
      await queryClient.invalidateQueries({
        queryKey: studioKeys.draftSourceView(draftId, agentFile),
      })
      setValidation(undefined)
      setPlan(undefined)
      setApplyResult(undefined)
      if (!current) {
        toast.warning("O draft mudou durante a gravação; o texto local foi preservado")
        return
      }
      toast.success("Arquivo estruturado salvo no draft")
    },
    onError: (error) => toast.error(
      error instanceof Error ? error.message : "Falha ao salvar arquivo estruturado",
    ),
  })

  const validate = useMutation({
    mutationFn: (snapshot: DraftFileSessionSnapshot) =>
      studioApi.validateDraft(snapshot.draftId, snapshot.serverEtag),
    onSuccess: (response, snapshot) => {
      const current = files.operationResponseIsCurrent(response.draft, snapshot)
      publishDraft(response.draft, snapshot)
      setPlan(undefined)
      if (!current) {
        setValidation(undefined)
        toast.warning("O agent mudou durante a validação; o resultado ficou obsoleto")
        return
      }
      setValidation(response.validation)
      toast[response.validation.status === "valid" ? "success" : "error"](
        response.validation.status === "valid" ? "Agent válido" : "Agent inválido",
      )
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Falha ao validar"),
  })

  const saveCurrent = useCallback(() => withSnapshot((snapshot) => save.mutate(snapshot)), [save, withSnapshot])
  const validateCurrent = useCallback(() => withSnapshot((snapshot) => validate.mutate(snapshot)), [validate, withSnapshot])
  useAgentEditorAutomation({
    canMutate: session.canMutate,
    hasFileChanges: files.hasLocalChanges,
    hasLocalChanges,
    contentRevision: draft.data?.content_revision,
    saving: save.isPending,
    editing: structuredEdit.isPending,
    writing: structuredFileWrite.isPending,
    validating: validate.isPending,
    save: saveCurrent,
    validate: validateCurrent,
  })

  const whereUsed = useMemo(
    () => (workflows.data?.workflows ?? []).filter(
      (workflow) => workflow.agents.includes(draft.data?.primary_resource.id ?? ""),
    ),
    [draft.data?.primary_resource.id, workflows.data?.workflows],
  )

  const saveSourceOperations = useCallback((operations: readonly YamlSourceOperation[]) => {
    if (files.hasLocalChanges) {
      toast.error("Salve ou descarte o raw local antes da edição estruturada")
      return
    }
    withSnapshot((snapshot) => structuredEdit.mutate({ snapshot, operations }))
  }, [files.hasLocalChanges, structuredEdit, withSnapshot])

  const saveStructuredFile = useCallback((file: DraftFile, content: string) => {
    if (files.hasLocalChanges) {
      toast.error("Salve ou descarte o raw local antes da edição estruturada")
      return
    }
    withSnapshot((snapshot) => structuredFileWrite.mutate({ snapshot, file, content }))
  }, [files.hasLocalChanges, structuredFileWrite, withSnapshot])

  if (draft.isPending) return <div className="p-6"><PageLoading label="Abrindo agent" /></div>
  if (draft.isError) return <div className="p-6"><PageError error={draft.error} retry={() => void draft.refetch()} /></div>
  if (draft.data.primary_resource.kind !== "agent") {
    return <div className="p-6"><PageEmpty title="Este draft não é um agent" description="Abra-o pelo catálogo de workflows." /></div>
  }

  const canRunCommands = session.canMutate && !hasLocalChanges
  const sideEffectProjectionUnavailable = authoringAuthorityUnavailable(
    hasLocalChanges,
    [sourceView],
  )
  const sideEffects = agentSideEffectPreview(
    sideEffectProjectionUnavailable ? undefined : sourceView.data?.value,
    draft.data.primary_resource.id,
  )
  const structuredPending = save.isPending || structuredEdit.isPending || structuredFileWrite.isPending
  const testBenchPending = structuredPending || validate.isPending
  const structuredAuthorities = [sourceView, library, models, agents, runtime, workflows] as const
  const missingStructuredAuthority = structuredAuthorities.find((query) => query.data === undefined)
  const structuredAuthorityError = missingStructuredAuthority?.isError === true
    ? missingStructuredAuthority.error
    : undefined
  const structuredAuthorityPending = missingStructuredAuthority !== undefined && structuredAuthorityError === undefined
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b bg-background px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <Button variant="ghost" size="sm" className="mb-1 -ml-2" onClick={() => void navigate("/agents")}><ArrowLeftIcon aria-hidden="true" /> Agents</Button>
            <div className="flex flex-wrap items-center gap-2"><h1 className="font-heading text-lg font-semibold">{draft.data.primary_resource.id}</h1><DraftStatusBadge status={draft.data.status} />{save.isPending ? <Badge variant="outline"><LoaderCircleIcon className="animate-spin" aria-hidden="true" /> Salvando…</Badge> : hasLocalChanges ? <Badge variant="outline">Alterações pendentes</Badge> : <Badge variant="outline"><CheckCircle2Icon aria-hidden="true" /> Salvo</Badge>}{validate.isPending && <Badge variant="outline"><LoaderCircleIcon className="animate-spin" aria-hidden="true" /> Verificando…</Badge>}</div>
            <p className="mt-1 text-xs text-muted-foreground">Draft {shortDigest(draftId, 12)} · revision {draft.data.record_revision} · atualizado {formatDateTime(draft.data.updated_at)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setActiveView("test-bench")}><PlayIcon aria-hidden="true" /> Testar</Button>
            <Button disabled={!canRunCommands || draft.data.status !== "valid" || planApply.isPending} onClick={() => planApply.mutate()}><FileDiffIcon aria-hidden="true" />Aplicar</Button>
          </div>
        </div>
        {applyResult !== undefined && <p className="mt-2 text-xs text-emerald-700" role="status">Aplicado em {formatDateTime(applyResult.committed_at)}; operação {shortDigest(applyResult.operation_id, 12)}.</p>}
      </header>

      <Tabs value={activeView} onValueChange={setActiveView} className="min-h-0 flex-1 gap-0">
        <div className="flex items-center justify-between border-b px-4"><TabsList variant="line"><TabsTrigger value="studio">Configurar</TabsTrigger><TabsTrigger value="test-bench">Testar</TabsTrigger><TabsTrigger value="problems">Problemas</TabsTrigger>{technicalOpen && <TabsTrigger value="files">Arquivos</TabsTrigger>}</TabsList><Button size="sm" variant={technicalOpen ? "secondary" : "ghost"} onClick={() => setTechnicalOpen((current) => !current)}><Settings2Icon aria-hidden="true" /> Técnico</Button></div>
        <TabsContent value="studio" className="min-h-0" keepMounted>
          {structuredAuthorityPending ? (
            <div className="p-6"><PageLoading label="Carregando autoridade do agent" /></div>
          ) : structuredAuthorityError !== undefined ? (
            <div className="p-6">
              <PageError
                error={structuredAuthorityError}
                retry={() => void Promise.all([
                  sourceView.refetch(),
                  library.refetch(),
                  models.refetch(),
                  agents.refetch(),
                  runtime.refetch(),
                  workflows.refetch(),
                ])}
              />
            </div>
          ) : (
            <AgentStructuredEditor
              agentId={draft.data.primary_resource.id}
              source={sourceView.data?.value}
              files={files.files}
              contents={files.baseContents}
              models={models.data}
              library={library.data}
              agents={agents.data?.agents ?? []}
              agentsCatalogStatus={agents.data?.status ?? "partial"}
              runtime={runtime.data}
              workflows={whereUsed}
              workflowsCatalogStatus={workflows.data?.status ?? "partial"}
              canMutate={session.canMutate}
              rawLocalChanges={files.hasLocalChanges}
              pending={structuredPending}
              onDirtyChange={setStructuredLocalChanges}
              onSourceSave={saveSourceOperations}
              onFileSave={saveStructuredFile}
            />
          )}
        </TabsContent>
        <TabsContent value="test-bench" className="p-4 sm:p-6" keepMounted>
          <AgentDraftTestBench
            draftId={draftId}
            etag={draft.data.etag}
            canMutate={session.canMutate}
            hasLocalChanges={hasLocalChanges}
            pending={testBenchPending}
          />
        </TabsContent>
        <TabsContent value="files" className="min-h-0"><DraftFilesEditor files={files.files} baseContents={files.baseContents} contents={files.workingContents} selectedFileKey={files.selectedFileKey} canMutate={session.canMutate && !structuredLocalChanges && !structuredPending} onSelectFile={files.selectFile} onContentChange={(key, content) => { files.editContent(key, content); setValidation(undefined); setPlan(undefined) }} /></TabsContent>
        <TabsContent value="problems" className="p-4 sm:p-6"><ProblemsPanel diagnostics={validation?.diagnostics ?? []} validated={validation !== undefined} /></TabsContent>
      </Tabs>

      <div className="border-t px-4 py-3"><Button className="border-destructive/40 text-foreground" variant="destructive" size="sm" disabled={!session.canMutate || hasLocalChanges || structuredPending} onClick={() => setDeleteOpen(true)}><Trash2Icon aria-hidden="true" />Remover draft</Button></div>
      <ApplyPlanDialog plan={plan} open={planOpen} applying={apply.isPending} sideEffects={sideEffects} onOpenChange={setPlanOpen} onApply={() => apply.mutate()} />
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remover draft do agent?</AlertDialogTitle><AlertDialogDescription>Somente o change set isolado será removido.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>Remover</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      <AlertDialog open={navigationBlocker.state === "blocked"} onOpenChange={(open) => { if (!open && navigationBlocker.state === "blocked") navigationBlocker.reset() }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Descartar alterações não salvas?</AlertDialogTitle><AlertDialogDescription>O texto alterado apenas nesta aba será perdido.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Continuar editando</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { if (navigationBlocker.state === "blocked") navigationBlocker.proceed() }}>Descartar e sair</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  )
}
