import { useMemo, useState } from "react"
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
import { useWorkflowTestDataRouteState } from "@/features/workflows/use-workflow-test-data-route-state"
import { workflowSourceNodes } from "@/features/workflows/workflow-source-model"
import {
  workflowNodeTestDataStates,
  workflowTestDataEntries,
} from "@/features/workflows/workflow-test-data-model"
import type { WorkflowTestDataControls } from "@/features/workflows/workflow-test-data-bar"
import {
  workflowTestDataNodeIdsForScope,
  type WorkflowTestScopeKind,
} from "@/features/workflows/workflow-test-scope"
import { LaunchPage } from "@/pages/launch-page"
import type { RunPlanInput } from "@/api/types"

export function WorkflowEditorPage() {
  const { draftId = "" } = useParams()
  const navigate = useNavigate()
  const [testOpen, setTestOpen] = useState(false)
  const [testScope, setTestScope] = useState<RunPlanInput["execution_scope"]>({ kind: "workflow" })
  const editor = useWorkflowEditorController(draftId)
  const { draft } = editor
  const sourceNodes = useMemo(
    () => workflowSourceNodes(editor.resources.sourceView.data?.value ?? {}),
    [editor.resources.sourceView.data?.value],
  )
  const nodeIds = useMemo(
    () => new Set(sourceNodes.map((node) => node.id)),
    [sourceNodes],
  )
  const fixtureNames = useMemo(
    () => new Set(Object.keys(editor.view.expressionFixtures)),
    [editor.view.expressionFixtures],
  )
  const testDataEntries = useMemo(
    () => workflowTestDataEntries(
      editor.view.expressionFixtures,
      editor.view.expressionFixtureSources,
      nodeIds,
    ),
    [editor.view.expressionFixtureSources, editor.view.expressionFixtures, nodeIds],
  )
  const fixtureNodeIds = useMemo(() => new Map(
    testDataEntries.flatMap((entry) => entry.eligibility.kind === "eligible"
      ? [[entry.name, entry.eligibility.nodeId] as const]
      : []),
  ), [testDataEntries])
  const testDataRoute = useWorkflowTestDataRouteState({
    ready: draft.data !== undefined && editor.resources.sourceView.data !== undefined,
    fixtureNames,
    fixtureNodeIds,
    nodeIds,
    onSelectNode: editor.view.setSelectedNodeId,
  })
  const activeFixtureNames = useMemo(
    () => new Set(testDataRoute.activeFixtureNames),
    [testDataRoute.activeFixtureNames],
  )
  const testDataNodeStates = useMemo(
    () => workflowNodeTestDataStates(testDataEntries, activeFixtureNames),
    [activeFixtureNames, testDataEntries],
  )
  const activeTestData = useMemo(() => {
    const entriesByName = new Map(testDataEntries.map((entry) => [entry.name, entry]))
    return testDataRoute.activeFixtureNames.flatMap((name) => {
      const active = entriesByName.get(name)
      return active?.eligibility.kind === "eligible"
        ? [{ fixtureName: active.name, nodeId: active.eligibility.nodeId }]
        : []
    })
  }, [testDataEntries, testDataRoute.activeFixtureNames])
  const launchTestData = useMemo(() => {
    const relevantNodeIds = workflowTestDataNodeIdsForScope(sourceNodes, testScope)
    return relevantNodeIds === undefined
      ? activeTestData
      : activeTestData.filter((entry) => relevantNodeIds.has(entry.nodeId))
  }, [activeTestData, sourceNodes, testScope])
  const testData: WorkflowTestDataControls = {
    entries: testDataEntries,
    activeFixtureNames,
    previewFixtureName: testDataRoute.previewFixtureName,
    nodeStates: testDataNodeStates,
    panelOpen: testDataRoute.panelOpen,
    disabled: !editor.permissions.canRunCommands || editor.pending.saveLayout || editor.pending.pinnedOutput,
    onOpenChange: (open) => open ? testDataRoute.openPanel() : testDataRoute.closePanel(),
    onToggle: (entry) => {
      if (entry.eligibility.kind === "eligible") {
        testDataRoute.toggleTestData(entry.name, entry.eligibility.nodeId)
      }
    },
    onPreview: (entry) => testDataRoute.selectPreviewFixture(entry.name, entry.source?.node_id),
    onClearAll: testDataRoute.clearAll,
    onRemove: (name) => {
      testDataRoute.removeFixture(name)
      editor.actions.removeExpressionFixture(name)
    },
    onEdit: (entry, output) => editor.actions.editPinnedOutput(entry.name, output),
    onDespin: (entry) => {
      testDataRoute.removeFixture(entry.name)
      editor.actions.despinOutput(entry.name)
    },
  }

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
    <div className="flex h-full min-h-0 flex-col">
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
        testData={testData}
        onTestThroughNode={(nodeId) => {
          setTestScope({ kind: "through_node", node_id: nodeId })
          setTestOpen(true)
        }}
        onTestScopedNode={(kind: WorkflowTestScopeKind, nodeId) => {
          setTestScope({ kind, node_id: nodeId })
          setTestOpen(true)
        }}
      />

      <Sheet open={testOpen} onOpenChange={setTestOpen}>
        <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto">
          <SheetHeader className="border-b">
            <SheetTitle>
              {testScope.kind === "workflow"
                ? `Testar ${draft.data.primary_resource.id}`
                : testScope.kind === "through_node"
                  ? `Executar até ${testScope.node_id}`
                  : testScope.kind === "isolated_node"
                    ? `Executar somente ${testScope.node_id}`
                    : `Executar de ${testScope.node_id} em diante`}
            </SheetTitle>
            <SheetDescription>
              {testScope.kind === "workflow"
                ? "Escolha dados reais ou uma invocation avançada sem sair do canvas."
                : testScope.kind === "through_node"
                  ? "Executa o passo selecionado e todas as dependências anteriores, sem percorrer o restante do fluxo."
                  : testScope.kind === "isolated_node"
                    ? "Executa apenas o passo selecionado; todas as entradas anteriores vêm dos dados salvos ativos."
                    : "Executa o passo selecionado e os próximos; entradas externas vêm dos dados salvos ativos."}
            </SheetDescription>
          </SheetHeader>
          <LaunchPage
            expectedWorkflow={draft.data.primary_resource.id}
            definitionSource={{
              kind: "draft",
              draft_id: draft.data.draft_id,
              etag: draft.data.etag,
            }}
            executionScope={testScope}
            testData={launchTestData}
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
