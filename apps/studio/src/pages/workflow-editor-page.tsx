import { useState } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { draftHref } from "@/features/drafts/draft-route"
import { ApplyPlanDialog } from "@/features/workflows/apply-plan-dialog"
import {
  UnsavedWorkflowNavigationDialog,
  WorkflowDraftDeleteControl,
} from "@/features/workflows/workflow-editor-dialogs"
import { WorkflowEditorHeader } from "@/features/workflows/workflow-editor-header"
import { WorkflowEditorWorkspace } from "@/features/workflows/workflow-editor-workspace"
import { useWorkflowEditorController } from "@/features/workflows/use-workflow-editor-controller"
import { LaunchPage } from "@/pages/launch-page"
import type { RunPlanInput } from "@/api/types"

export function WorkflowEditorPage() {
  const { draftId = "" } = useParams()
  const navigate = useNavigate()
  const [testOpen, setTestOpen] = useState(false)
  const [testScope, setTestScope] = useState<RunPlanInput["execution_scope"]>({ kind: "workflow" })
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
        canUndo={editor.view.canUndo}
        canRedo={editor.view.canRedo}
        onUndo={editor.actions.undo}
        onRedo={editor.actions.redo}
        onTest={() => {
          setTestScope({ kind: "workflow" })
          setTestOpen(true)
        }}
        onPlanApply={() => editor.actions.planApply(true)}
      />

      <WorkflowEditorWorkspace
        draft={draft.data}
        editor={editor}
        onTestThroughNode={(nodeId) => {
          setTestScope({ kind: "through_node", node_id: nodeId })
          setTestOpen(true)
        }}
      />

      <Sheet open={testOpen} onOpenChange={setTestOpen}>
        <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto">
          <SheetHeader className="border-b">
            <SheetTitle>
              {testScope.kind === "through_node" ? `Executar até ${testScope.node_id}` : `Testar ${draft.data.primary_resource.id}`}
            </SheetTitle>
            <SheetDescription>
              {testScope.kind === "through_node"
                ? "Executa o passo selecionado e todas as dependências anteriores, sem percorrer o restante do fluxo."
                : "Escolha dados reais ou uma invocation avançada sem sair do canvas."}
            </SheetDescription>
          </SheetHeader>
          <LaunchPage
            expectedWorkflow={draft.data.primary_resource.id}
            executionScope={testScope}
            embedded
          />
        </SheetContent>
      </Sheet>

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
