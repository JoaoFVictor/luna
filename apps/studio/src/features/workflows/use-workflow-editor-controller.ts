import { useCallback, useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useBlocker, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import {
  agentsQuery,
  draftQuery,
  draftSourceViewQuery,
  libraryQuery,
  studioKeys,
} from "@/api/queries"
import type {
  CompiledWorkflow,
  DraftItem,
  DraftValidationResult,
  JsonValue,
  StudioPath,
  YamlSourceOperation,
} from "@/api/types"
import { useEditorState, useStudioSession } from "@/app/studio-context"
import {
  draftFileWriteEdits,
  type DraftFileSessionSnapshot,
} from "@/features/drafts/draft-file-session"
import { authoringAuthorityUnavailable } from "@/features/drafts/authoring-authority"
import { useDraftFileSession } from "@/features/drafts/use-draft-file-session"
import {
  withoutWorkflowExpressionFixture,
  withWorkflowExpressionFixture,
  workflowExpressionFixtures,
} from "@/features/workflows/workflow-expression-fixtures"
import {
  withWorkflowPositions,
  type WorkflowPositions,
} from "@/features/workflows/workflow-layout"
import {
  workflowSideEffectPreview,
  type WorkflowSideEffectPreview,
} from "@/features/workflows/workflow-side-effect-preview"
import { useWorkflowApply } from "@/features/workflows/use-workflow-apply"

function findCompiledWorkflow(
  validation: DraftValidationResult | undefined,
): CompiledWorkflow | undefined {
  return validation?.resources.find(
    (resource) =>
      resource.resource.kind === "workflow" &&
      resource.compiled_workflow !== undefined,
  )?.compiled_workflow
}

const UNKNOWN_SIDE_EFFECTS: readonly WorkflowSideEffectPreview[] = [{
  nodeId: "workflow",
  source: "agent_tools",
  semantics: "unknown",
  description: "Catálogos de capabilities/agents ainda indisponíveis; side effects não podem ser descartados",
  operationIds: [],
}]

export function useWorkflowEditorController(draftId: string) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useStudioSession()
  const { setHasLocalChanges } = useEditorState()
  const draft = useQuery(draftQuery(draftId))
  const library = useQuery(libraryQuery)
  const agents = useQuery(agentsQuery)
  const workflowFile = useMemo<StudioPath>(() => ({
    root: "project",
    path: `workflows/${draft.data?.primary_resource.id ?? "pending"}/workflow.yaml`,
  }), [draft.data?.primary_resource.id])
  const sourceView = useQuery({
    ...draftSourceViewQuery(draftId, workflowFile),
    enabled: draft.data?.primary_resource.kind === "workflow",
  })
  const fileSession = useDraftFileSession(draft.data)
  const {
    acceptServerDraft,
    captureSnapshot,
    editContent: editFileContent,
    operationResponseIsCurrent,
  } = fileSession
  const [validation, setValidation] = useState<DraftValidationResult>()
  const [selectedNodeId, setSelectedNodeId] = useState<string>()
  const [activeView, setActiveView] = useState("design")
  const [deleteOpen, setDeleteOpen] = useState(false)
  const navigationBlocker = useBlocker(fileSession.hasLocalChanges)
  const compiled = findCompiledWorkflow(validation)
  const expressionFixtures = useMemo(
    () => workflowExpressionFixtures(draft.data?.layout),
    [draft.data?.layout],
  )
  const sideEffects = useMemo<readonly WorkflowSideEffectPreview[]>(() => {
    if (
      authoringAuthorityUnavailable(fileSession.hasLocalChanges, [
        sourceView,
        library,
        agents,
      ]) ||
      sourceView.data === undefined ||
      library.data === undefined ||
      agents.data === undefined
    ) {
      return UNKNOWN_SIDE_EFFECTS
    }
    return workflowSideEffectPreview(
      sourceView.data.value,
      library.data,
      agents.data.agents,
      agents.data.status === "complete",
    )
  }, [
    agents.data,
    agents.isError,
    agents.isFetching,
    fileSession.hasLocalChanges,
    library.data,
    library.isError,
    library.isFetching,
    sourceView.data,
    sourceView.isError,
    sourceView.isFetching,
  ])

  const workflowApply = useWorkflowApply({
    draftId,
    draft: draft.data,
    refetchDraft: draft.refetch,
  })
  const {
    resetContentDerivedState: resetWorkflowApplyContentState,
    resetPlan: resetWorkflowApplyPlan,
  } = workflowApply

  const invalidateContentDerivedState = useCallback(() => {
    setValidation(undefined)
    resetWorkflowApplyContentState()
  }, [resetWorkflowApplyContentState])

  const publishServerDraft = useCallback(
    (nextDraft: DraftItem, operationSnapshot: DraftFileSessionSnapshot) => {
      acceptServerDraft(nextDraft, operationSnapshot)
      queryClient.setQueryData<DraftItem>(
        studioKeys.draft(nextDraft.draft_id),
        (current) =>
          current !== undefined && current.record_revision > nextDraft.record_revision
            ? current
            : nextDraft,
      )
      void queryClient.invalidateQueries({ queryKey: studioKeys.drafts })
    },
    [acceptServerDraft, queryClient],
  )

  const beginFileOperation = useCallback(
    (operation: (snapshot: DraftFileSessionSnapshot) => void) => {
      const snapshot = captureSnapshot()
      if (snapshot === undefined) {
        toast.error("A sessão de arquivos do draft ainda não está pronta")
        return
      }
      operation(snapshot)
    },
    [captureSnapshot],
  )

  const acceptCurrentOperation = useCallback((
    nextDraft: DraftItem,
    snapshot: DraftFileSessionSnapshot,
    staleMessage: string,
  ): boolean => {
    const responseIsCurrent = operationResponseIsCurrent(
      nextDraft,
      snapshot,
    )
    publishServerDraft(nextDraft, snapshot)
    if (!responseIsCurrent) {
      invalidateContentDerivedState()
      toast.warning(staleMessage)
    }
    return responseIsCurrent
  }, [invalidateContentDerivedState, operationResponseIsCurrent, publishServerDraft])

  useEffect(() => {
    setHasLocalChanges(fileSession.hasLocalChanges)
    return () => setHasLocalChanges(false)
  }, [fileSession.hasLocalChanges, setHasLocalChanges])

  useEffect(() => {
    if (!fileSession.hasLocalChanges) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warnBeforeUnload)
    return () => window.removeEventListener("beforeunload", warnBeforeUnload)
  }, [fileSession.hasLocalChanges])

  const saveDraft = useMutation({
    mutationFn: async (snapshot: DraftFileSessionSnapshot) => {
      const edits = draftFileWriteEdits(snapshot)
      if (edits.length === 0) {
        throw new Error("Não há alterações locais para salvar")
      }
      return await studioApi.patchDraft(
        snapshot.draftId,
        snapshot.serverEtag,
        edits,
      )
    },
    onSuccess: async (saved, snapshot) => {
      publishServerDraft(saved, snapshot)
      invalidateContentDerivedState()
      await queryClient.invalidateQueries({
        queryKey: studioKeys.draftSourceView(draftId, workflowFile),
      })
      toast.success("Draft salvo no armazenamento isolado")
    },
    onError: (error) => toast.error(
      error instanceof Error ? error.message : "Falha ao salvar draft",
    ),
  })

  const validateDraft = useMutation({
    mutationFn: (snapshot: DraftFileSessionSnapshot) =>
      studioApi.validateDraft(snapshot.draftId, snapshot.serverEtag),
    onSuccess: (response, snapshot) => {
      if (!acceptCurrentOperation(
        response.draft,
        snapshot,
        "O draft mudou durante a validação; o texto foi preservado e o resultado ficou obsoleto",
      )) return
      setValidation(response.validation)
      setSelectedNodeId(undefined)
      resetWorkflowApplyPlan()
      toast[response.validation.status === "valid" ? "success" : "error"](
        response.validation.status === "valid" ? "Draft válido" : "Draft inválido",
      )
    },
    onError: (error) => toast.error(
      error instanceof Error ? error.message : "Falha na validação",
    ),
  })

  const compileDraft = useMutation({
    mutationFn: (snapshot: DraftFileSessionSnapshot) =>
      studioApi.compileDraft(snapshot.draftId, snapshot.serverEtag),
    onSuccess: (response, snapshot) => {
      if (!acceptCurrentOperation(
        response.draft,
        snapshot,
        "O draft mudou durante a compilação; o texto foi preservado e o resultado ficou obsoleto",
      )) return
      setValidation(response.validation)
      resetWorkflowApplyPlan()
      const graph = findCompiledWorkflow(response.validation)
      setSelectedNodeId(graph?.nodes[0]?.id)
      setActiveView(response.validation.status === "valid" ? "design" : "problems")
      toast[response.validation.status === "valid" ? "success" : "error"](
        response.validation.status === "valid" ? "Workflow compilado" : "Compilação encontrou erros",
      )
    },
    onError: (error) => toast.error(
      error instanceof Error ? error.message : "Falha na compilação",
    ),
  })

  const structuredEdit = useMutation({
    mutationFn: async ({
      snapshot,
      operations,
    }: {
      snapshot: DraftFileSessionSnapshot
      operations: readonly YamlSourceOperation[]
    }) => studioApi.editDraftSource(
      snapshot.draftId,
      snapshot.serverEtag,
      workflowFile,
      operations,
    ),
    onSuccess: async (updated, { snapshot }) => {
      const responseIsCurrent = operationResponseIsCurrent(
        updated,
        snapshot,
      )
      publishServerDraft(updated, snapshot)
      await queryClient.invalidateQueries({
        queryKey: studioKeys.draftSourceView(draftId, workflowFile),
      })
      if (!responseIsCurrent) {
        invalidateContentDerivedState()
        toast.warning("O draft mudou durante a edição estruturada; o texto local foi preservado")
        return
      }
      invalidateContentDerivedState()
      toast.success("Edição salva; compile para validar a DAG")
    },
    onError: (error) => toast.error(
      error instanceof Error ? error.message : "Falha na edição estruturada",
    ),
  })

  const saveLayout = useMutation({
    mutationFn: async ({
      snapshot,
      layout,
    }: {
      snapshot: DraftFileSessionSnapshot
      layout: JsonValue
      successMessage: string
    }) => studioApi.patchDraftLayout(
      snapshot.draftId,
      snapshot.serverEtag,
      layout,
    ),
    onSuccess: (updated, { snapshot, successMessage }) => {
      publishServerDraft(updated, snapshot)
      toast.success(successMessage)
    },
    onError: (error) => toast.error(
      error instanceof Error ? error.message : "Falha ao salvar layout",
    ),
  })

  const deleteDraft = useMutation({
    mutationFn: async () => {
      if (draft.data === undefined) throw new Error("Draft indisponível")
      await studioApi.deleteDraft(draftId, draft.data.etag)
    },
    onSuccess: () => {
      setHasLocalChanges(false)
      void queryClient.invalidateQueries({ queryKey: studioKeys.drafts })
      toast.success("Draft removido")
      void navigate("/workflows")
    },
    onError: (error) => toast.error(
      error instanceof Error ? error.message : "Falha ao remover draft",
    ),
  })

  const save = useCallback(() => {
    beginFileOperation((snapshot) => saveDraft.mutate(snapshot))
  }, [beginFileOperation, saveDraft])
  const validate = useCallback(() => {
    beginFileOperation((snapshot) => validateDraft.mutate(snapshot))
  }, [beginFileOperation, validateDraft])
  const compile = useCallback(() => {
    beginFileOperation((snapshot) => compileDraft.mutate(snapshot))
  }, [beginFileOperation, compileDraft])
  const editSource = useCallback((operations: readonly YamlSourceOperation[]) => {
    beginFileOperation((snapshot) => structuredEdit.mutate({ snapshot, operations }))
  }, [beginFileOperation, structuredEdit])
  const editContent = useCallback((key: string, content: string) => {
    editFileContent(key, content)
    invalidateContentDerivedState()
  }, [editFileContent, invalidateContentDerivedState])
  const persistLayout = useCallback((layout: JsonValue, successMessage: string) => {
    beginFileOperation((snapshot) => saveLayout.mutate({
      snapshot,
      layout,
      successMessage,
    }))
  }, [beginFileOperation, saveLayout])
  const savePositions = useCallback((positions: WorkflowPositions) => {
    if (draft.data === undefined) return
    persistLayout(
      withWorkflowPositions(draft.data.layout, positions),
      "Layout salvo no sidecar do draft",
    )
  }, [draft.data, persistLayout])
  const saveExpressionFixture = useCallback((name: string, value: JsonValue) => {
    if (draft.data === undefined) return
    persistLayout(
      withWorkflowExpressionFixture(draft.data.layout, name, value),
      `Fixture ${name} salva no sidecar do draft`,
    )
  }, [draft.data, persistLayout])
  const removeExpressionFixture = useCallback((name: string) => {
    if (draft.data === undefined) return
    persistLayout(
      withoutWorkflowExpressionFixture(draft.data.layout, name),
      `Fixture ${name} removida do sidecar do draft`,
    )
  }, [draft.data, persistLayout])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLocaleLowerCase() === "s") {
        event.preventDefault()
        if (
          session.canMutate &&
          fileSession.hasLocalChanges &&
          !saveDraft.isPending
        ) save()
      }
      if (event.key === "Enter") {
        event.preventDefault()
        if (
          session.canMutate &&
          !fileSession.hasLocalChanges &&
          !compileDraft.isPending
        ) compile()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [compile, compileDraft.isPending, fileSession.hasLocalChanges, save, saveDraft.isPending, session.canMutate])

  const canRunCommands = session.canMutate && !fileSession.hasLocalChanges

  return {
    draft,
    resources: { library, agents, sourceView },
    files: fileSession,
    view: {
      active: activeView,
      setActive: setActiveView,
      validation,
      compiled,
      selectedNodeId,
      setSelectedNodeId,
      expressionFixtures,
    },
    apply: {
      plan: workflowApply.plan,
      open: workflowApply.open,
      setOpen: workflowApply.setOpen,
      result: workflowApply.result,
      sideEffects,
    },
    permissions: {
      canMutate: session.canMutate,
      canRunCommands,
      canPlan: canRunCommands && draft.data?.status === "valid",
    },
    pending: {
      save: saveDraft.isPending,
      validate: validateDraft.isPending,
      compile: compileDraft.isPending,
      structuredEdit: structuredEdit.isPending,
      saveLayout: saveLayout.isPending,
      plan: workflowApply.planning,
      apply: workflowApply.applying,
      delete: deleteDraft.isPending,
    },
    actions: {
      save,
      validate,
      compile,
      editSource,
      editContent,
      savePositions,
      saveExpressionFixture,
      removeExpressionFixture,
      planApply: workflowApply.planApply,
      apply: workflowApply.apply,
      deleteDraft: () => deleteDraft.mutate(),
    },
    deleteDialog: {
      open: deleteOpen,
      setOpen: setDeleteOpen,
    },
    navigation: {
      blocked: navigationBlocker.state === "blocked",
      keepEditing: () => {
        if (navigationBlocker.state === "blocked") navigationBlocker.reset()
      },
      discardAndLeave: () => {
        if (navigationBlocker.state === "blocked") navigationBlocker.proceed()
      },
    },
  }
}

export type WorkflowEditorController = ReturnType<typeof useWorkflowEditorController>
