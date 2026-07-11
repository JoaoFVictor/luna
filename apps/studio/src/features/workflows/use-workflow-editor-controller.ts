import { useCallback, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import {
  agentsQuery,
  draftQuery,
  draftSourceViewQuery,
  inputAdaptersQuery,
  libraryQuery,
  routingQuery,
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
import { useStudioSession } from "@/app/studio-context"
import {
  draftFileWriteEdits,
  type DraftFileSessionSnapshot,
} from "@/features/drafts/draft-file-session"
import { useDraftFileSession } from "@/features/drafts/use-draft-file-session"
import { useDraftNavigationGuard } from "@/features/drafts/use-draft-navigation-guard"
import { workflowExpressionFixtures } from "@/features/workflows/workflow-expression-fixtures"
import {
  workflowNodeNotes,
} from "@/features/workflows/workflow-layout"
import {
  workflowOperationHistoryEntry,
  type WorkflowOperationHistoryEntry,
} from "@/features/workflows/workflow-operation-history"
import { useWorkflowApply } from "@/features/workflows/use-workflow-apply"
import { useWorkflowEditorAutomation } from "@/features/workflows/use-workflow-editor-automation"
import { useWorkflowSideEffectProjection } from "@/features/workflows/use-workflow-side-effect-preview"
import { useWorkflowLayoutActions } from "@/features/workflows/use-workflow-layout-actions"

function findCompiledWorkflow(
  validation: DraftValidationResult | undefined,
): CompiledWorkflow | undefined {
  return validation?.resources.find(
    (resource) =>
      resource.resource.kind === "workflow" &&
      resource.compiled_workflow !== undefined,
  )?.compiled_workflow
}

type WorkflowHistoryAction = {
  readonly kind: "record" | "undo" | "redo"
  readonly entry: WorkflowOperationHistoryEntry
}

export function useWorkflowEditorController(draftId: string) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useStudioSession()
  const draft = useQuery(draftQuery(draftId))
  const library = useQuery(libraryQuery)
  const agents = useQuery(agentsQuery)
  const inputAdapters = useQuery(inputAdaptersQuery)
  const routing = useQuery(routingQuery)
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
  const [undoStack, setUndoStack] = useState<readonly WorkflowOperationHistoryEntry[]>([])
  const [redoStack, setRedoStack] = useState<readonly WorkflowOperationHistoryEntry[]>([])
  const navigationBlocker = useDraftNavigationGuard(fileSession.hasLocalChanges)
  const compiled = findCompiledWorkflow(validation)
  const expressionFixtures = useMemo(
    () => workflowExpressionFixtures(draft.data?.layout),
    [draft.data?.layout],
  )
  const nodeNotes = useMemo(
    () => workflowNodeNotes(draft.data?.layout),
    [draft.data?.layout],
  )
  const sideEffects = useWorkflowSideEffectProjection({
    hasLocalChanges: fileSession.hasLocalChanges,
    sourceView,
    library,
    agents,
  })

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
    mutationFn: ({ snapshot }: {
      snapshot: DraftFileSessionSnapshot
      background: boolean
    }) => studioApi.compileDraft(snapshot.draftId, snapshot.serverEtag),
    onSuccess: (response, { snapshot, background }) => {
      if (!acceptCurrentOperation(
        response.draft,
        snapshot,
        "O draft mudou durante a compilação; o texto foi preservado e o resultado ficou obsoleto",
      )) return
      setValidation(response.validation)
      resetWorkflowApplyPlan()
      if (!background) {
        toast[response.validation.status === "valid" ? "success" : "error"](
          response.validation.status === "valid" ? "Workflow compilado" : "Compilação encontrou erros",
        )
      }
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
      historyAction?: WorkflowHistoryAction
    }) => studioApi.editDraftSource(
      snapshot.draftId,
      snapshot.serverEtag,
      workflowFile,
      operations,
    ),
    onSuccess: async (updated, { snapshot, historyAction }) => {
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
      if (historyAction?.kind === "record") {
        setUndoStack((current) => [...current.slice(-99), historyAction.entry])
        setRedoStack([])
      } else if (historyAction?.kind === "undo") {
        setUndoStack((current) => current.slice(0, -1))
        setRedoStack((current) => [...current.slice(-99), historyAction.entry])
      } else if (historyAction?.kind === "redo") {
        setRedoStack((current) => current.slice(0, -1))
        setUndoStack((current) => [...current.slice(-99), historyAction.entry])
      } else {
        setUndoStack([])
        setRedoStack([])
      }
      toast.success("Edição salva")
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
    beginFileOperation((snapshot) => compileDraft.mutate({ snapshot, background: false }))
  }, [beginFileOperation, compileDraft])
  const compileAutomatically = useCallback((background: boolean) => {
    beginFileOperation((snapshot) => compileDraft.mutate({ snapshot, background }))
  }, [beginFileOperation, compileDraft])
  const editSource = useCallback((operations: readonly YamlSourceOperation[]) => {
    const entry = sourceView.data === undefined
      ? undefined
      : workflowOperationHistoryEntry(sourceView.data.value, operations)
    beginFileOperation((snapshot) => structuredEdit.mutate({
      snapshot,
      operations,
      ...(entry === undefined
        ? {}
        : { historyAction: { kind: "record" as const, entry } }),
    }))
  }, [beginFileOperation, sourceView.data, structuredEdit])
  const undo = useCallback(() => {
    const entry = undoStack.at(-1)
    if (entry === undefined || structuredEdit.isPending) return
    beginFileOperation((snapshot) => structuredEdit.mutate({
      snapshot,
      operations: entry.backward,
      historyAction: { kind: "undo", entry },
    }))
  }, [beginFileOperation, structuredEdit, undoStack])
  const redo = useCallback(() => {
    const entry = redoStack.at(-1)
    if (entry === undefined || structuredEdit.isPending) return
    beginFileOperation((snapshot) => structuredEdit.mutate({
      snapshot,
      operations: entry.forward,
      historyAction: { kind: "redo", entry },
    }))
  }, [beginFileOperation, redoStack, structuredEdit])
  const editContent = useCallback((key: string, content: string) => {
    editFileContent(key, content)
    invalidateContentDerivedState()
    setUndoStack([])
    setRedoStack([])
  }, [editFileContent, invalidateContentDerivedState])
  const persistLayout = useCallback((layout: JsonValue, successMessage: string) => {
    beginFileOperation((snapshot) => saveLayout.mutate({
      snapshot,
      layout,
      successMessage,
    }))
  }, [beginFileOperation, saveLayout])
  const layoutActions = useWorkflowLayoutActions(draft.data, persistLayout)

  useWorkflowEditorAutomation({
    canMutate: session.canMutate,
    hasLocalChanges: fileSession.hasLocalChanges,
    contentRevision: draft.data?.content_revision,
    saving: saveDraft.isPending,
    editing: structuredEdit.isPending,
    compiling: compileDraft.isPending,
    save,
    compile: compileAutomatically,
    undo,
    redo,
  })

  const canRunCommands = session.canMutate && !fileSession.hasLocalChanges

  return {
    draft,
    resources: { library, agents, inputAdapters, routing, sourceView },
    files: fileSession,
    view: {
      active: activeView,
      setActive: setActiveView,
      validation,
      compiled,
      selectedNodeId,
      setSelectedNodeId,
      expressionFixtures,
      nodeNotes,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
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
      undo,
      redo,
      editContent,
      ...layoutActions,
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
