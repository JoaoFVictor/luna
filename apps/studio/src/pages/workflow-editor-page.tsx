import { useNavigate, useParams } from "react-router-dom"

import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
import { Button } from "@/components/ui/button"
import { draftHref } from "@/features/drafts/draft-route"
import { ApplyPlanDialog } from "@/features/workflows/apply-plan-dialog"
import {
  UnsavedWorkflowNavigationDialog,
  WorkflowDraftDeleteControl,
} from "@/features/workflows/workflow-editor-dialogs"
import { WorkflowEditorHeader } from "@/features/workflows/workflow-editor-header"
import { WorkflowEditorWorkspace } from "@/features/workflows/workflow-editor-workspace"
import { useWorkflowEditorController } from "@/features/workflows/use-workflow-editor-controller"

export function WorkflowEditorPage() {
  const { draftId = "" } = useParams()
  const navigate = useNavigate()
  const editor = useWorkflowEditorController(draftId)
  const { draft } = editor

  if (draft.isPending) {
    return <div className="p-6"><PageLoading label="Abrindo draft" /></div>
  }
  if (draft.isError) {
    return (
      <div className="p-6">
        <PageError error={draft.error} retry={() => void draft.refetch()} />
      </div>
    )
  }
  if (draft.data.primary_resource.kind !== "workflow") {
    return (
      <div className="p-6">
        <PageEmpty
          title="Este draft não é de workflow"
          description="Abra o editor correspondente; nenhum conteúdo será descartado."
          action={(
            <Button onClick={() => void navigate(draftHref(draft.data))}>
              Abrir editor correto
            </Button>
          )}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-full flex-col">
      <WorkflowEditorHeader
        draft={draft.data}
        validation={editor.view.validation}
        hasLocalChanges={editor.files.hasLocalChanges}
        canMutate={editor.permissions.canMutate}
        saving={editor.pending.save}
        validating={editor.pending.validate}
        compiling={editor.pending.compile}
        planning={editor.pending.plan}
        applyResult={editor.apply.result}
        onSave={editor.actions.save}
        onValidate={editor.actions.validate}
        onCompile={editor.actions.compile}
        onPlanApply={() => editor.actions.planApply(true)}
      />

      <WorkflowEditorWorkspace draft={draft.data} editor={editor} />

      <ApplyPlanDialog
        plan={editor.apply.plan}
        open={editor.apply.open}
        applying={editor.pending.apply}
        sideEffects={editor.apply.sideEffects}
        onOpenChange={editor.apply.setOpen}
        onApply={editor.actions.apply}
      />

      <WorkflowDraftDeleteControl
        open={editor.deleteDialog.open}
        canDelete={editor.permissions.canMutate && !editor.files.hasLocalChanges}
        deleting={editor.pending.delete}
        onOpenChange={editor.deleteDialog.setOpen}
        onDelete={editor.actions.deleteDraft}
      />
      <UnsavedWorkflowNavigationDialog
        open={editor.navigation.blocked}
        onKeepEditing={editor.navigation.keepEditing}
        onDiscard={editor.navigation.discardAndLeave}
      />
    </div>
  )
}
