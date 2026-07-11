import {
  ActivityIcon,
  BracesIcon,
  Code2Icon,
  FileDiffIcon,
  FileJsonIcon,
  GitBranchIcon,
  ShieldAlertIcon,
  Settings2Icon,
} from "lucide-react"
import { useState } from "react"

import type { DraftItem } from "@/api/types"
import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { draftFileKey } from "@/features/drafts/draft-file-session"
import { DraftDiffView } from "@/features/workflows/draft-diff-view"
import { DraftFilesEditor } from "@/features/workflows/draft-files-editor"
import { ProblemsPanel } from "@/features/workflows/problems-panel"
import type { WorkflowEditorController } from "@/features/workflows/use-workflow-editor-controller"
import { WorkflowDesignView } from "@/features/workflows/workflow-design-view"
import { workflowCanvasLayout } from "@/features/workflows/workflow-layout"
import { WorkflowRunsPanel } from "@/features/workflows/workflow-runs-panel"
import { WorkflowSchemasEditor } from "@/features/workflows/workflow-schemas-editor"
import { shortDigest } from "@/lib/format"

function WorkflowDesignWorkspace({
  draft,
  editor,
  onTestThroughNode,
}: {
  draft: DraftItem
  editor: WorkflowEditorController
  onTestThroughNode: (nodeId: string) => void
}) {
  const { agents, inputAdapters, library, routing, sourceView } = editor.resources
  if (library.isPending || agents.isPending || sourceView.isPending) {
    return <div className="p-6"><PageLoading label="Carregando autoridade de edição" /></div>
  }
  if (library.isError) {
    return <div className="p-6"><PageError error={library.error} retry={() => void library.refetch()} /></div>
  }
  if (agents.isError) {
    return <div className="p-6"><PageError error={agents.error} retry={() => void agents.refetch()} /></div>
  }
  if (sourceView.isError) {
    return <div className="p-6"><PageError error={sourceView.error} retry={() => void sourceView.refetch()} /></div>
  }

  return (
    <WorkflowDesignView
      compiled={editor.view.compiled}
      workflowId={draft.primary_resource.id}
      diagnostics={editor.view.validation?.diagnostics}
      source={sourceView.data.value}
      library={library.data}
      agents={agents.data.agents}
      adapters={inputAdapters.data}
      routing={routing.data}
      agentCatalogComplete={agents.data.status === "complete"}
      canvasLayout={workflowCanvasLayout(draft.layout)}
      selectedNodeId={editor.view.selectedNodeId}
      canMutate={editor.permissions.canRunCommands}
      pending={editor.pending.structuredEdit || editor.pending.saveLayout}
      onOperations={editor.actions.editSource}
      onCanvasLayoutChange={editor.actions.saveCanvasLayout}
      expressionFixtures={editor.view.expressionFixtures}
      nodeNotes={editor.view.nodeNotes}
      onSaveExpressionFixture={editor.actions.saveExpressionFixture}
      onRemoveExpressionFixture={editor.actions.removeExpressionFixture}
      onSaveNodeNote={editor.actions.saveNodeNote}
      onSelectNode={editor.view.setSelectedNodeId}
      onTestThroughNode={onTestThroughNode}
    />
  )
}

function CompiledWorkflowView({ editor }: { editor: WorkflowEditorController }) {
  const compiled = editor.view.compiled
  if (compiled === undefined) {
    return (
      <PageEmpty
        title="Nenhuma projeção compilada"
        description="Compile o draft para ver a DAG e metadata resolvidas pelo compiler real."
      />
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Compiled workflow</CardTitle>
        <CardDescription>
          Revision {shortDigest(compiled.workflow_revision)} · state schema {compiled.state_schema_version}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="max-h-[65vh] overflow-auto rounded-lg bg-muted p-4 text-xs">
          {JSON.stringify(compiled, null, 2)}
        </pre>
      </CardContent>
    </Card>
  )
}

export function WorkflowEditorWorkspace({
  draft,
  editor,
  onTestThroughNode,
}: {
  draft: DraftItem
  editor: WorkflowEditorController
  onTestThroughNode: (nodeId: string) => void
}) {
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const yamlFiles = editor.files.files.filter(
    (file) => file.file.path.endsWith(".yaml") || file.file.path.endsWith(".yml"),
  )
  const yamlSelectedKey = yamlFiles.some(
    (file) => draftFileKey(file) === editor.files.selectedFileKey,
  )
    ? editor.files.selectedFileKey
    : yamlFiles[0] && draftFileKey(yamlFiles[0])
  const diagnosticCount = editor.view.validation?.diagnostics.length ?? 0

  return (
    <Tabs
      value={editor.view.active}
      onValueChange={editor.view.setActive}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="flex items-center justify-between gap-3 overflow-x-auto border-b px-4">
        <TabsList variant="line" className="h-10">
          <TabsTrigger value="design"><GitBranchIcon aria-hidden="true" /> Design</TabsTrigger>
          <TabsTrigger value="runs"><ActivityIcon aria-hidden="true" /> Execuções</TabsTrigger>
          <TabsTrigger value="problems">
            <ShieldAlertIcon aria-hidden="true" /> Problemas
            {diagnosticCount > 0 && <Badge variant="destructive">{diagnosticCount}</Badge>}
          </TabsTrigger>
          {technicalOpen && (
            <>
              <TabsTrigger value="yaml"><Code2Icon aria-hidden="true" /> YAML</TabsTrigger>
              <TabsTrigger value="schemas"><FileJsonIcon aria-hidden="true" /> Schemas</TabsTrigger>
              <TabsTrigger value="compiled"><BracesIcon aria-hidden="true" /> Compilado</TabsTrigger>
              <TabsTrigger value="diff"><FileDiffIcon aria-hidden="true" /> Diff</TabsTrigger>
            </>
          )}
        </TabsList>
        <Button size="sm" variant={technicalOpen ? "secondary" : "ghost"} onClick={() => setTechnicalOpen((current) => !current)}>
          <Settings2Icon aria-hidden="true" /> Técnico
        </Button>
      </div>

      <TabsContent value="design" className="min-h-0">
        <WorkflowDesignWorkspace
          draft={draft}
          editor={editor}
          onTestThroughNode={onTestThroughNode}
        />
      </TabsContent>

      <TabsContent value="yaml" className="min-h-0">
        <DraftFilesEditor
          files={yamlFiles}
          baseContents={editor.files.baseContents}
          contents={editor.files.workingContents}
          selectedFileKey={yamlSelectedKey}
          canMutate={editor.permissions.canMutate}
          onSelectFile={editor.files.selectFile}
          onContentChange={editor.actions.editContent}
        />
      </TabsContent>

      <TabsContent value="schemas" className="min-h-0">
        <WorkflowSchemasEditor
          files={editor.files.files}
          contents={editor.files.workingContents}
          canMutate={editor.permissions.canMutate}
          onContentChange={editor.actions.editContent}
        />
      </TabsContent>

      <TabsContent value="compiled" className="p-4 sm:p-6">
        <CompiledWorkflowView editor={editor} />
      </TabsContent>

      <TabsContent value="diff" className="min-h-0">
        <DraftDiffView
          files={editor.files.files}
          baseContents={editor.files.baseContents}
          workingContents={editor.files.workingContents}
          plan={editor.apply.plan}
          sideEffects={editor.apply.sideEffects}
          canPlan={editor.permissions.canPlan}
          planning={editor.pending.plan}
          onPlan={() => editor.actions.planApply(false)}
        />
      </TabsContent>

      <TabsContent value="runs" className="min-h-0">
        <WorkflowRunsPanel
          workflowId={draft.primary_resource.id}
          compiledRevision={editor.view.compiled?.workflow_revision}
        />
      </TabsContent>

      <TabsContent value="problems" className="p-4 sm:p-6">
        <ProblemsPanel
          diagnostics={editor.view.validation?.diagnostics ?? []}
          validated={editor.view.validation !== undefined}
        />
      </TabsContent>
    </Tabs>
  )
}
