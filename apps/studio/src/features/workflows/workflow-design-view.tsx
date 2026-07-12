import { useCallback, useEffect, useState } from "react"
import { ClipboardPasteIcon, HistoryIcon, ListTreeIcon, PinOffIcon, PlayIcon, Settings2Icon, WandSparklesIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import type {
  AgentCatalogItem,
  CapabilityCatalog,
  CompiledWorkflow,
  DraftValidationResult,
  InputAdapterCatalog,
  JsonValue,
  RouterDefinition,
  WorkflowSummary,
  YamlSourceOperation,
} from "@/api/types"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { WorkflowGraph } from "@/features/workflows/workflow-graph"
import { workflowDataConnections } from "@/features/workflows/workflow-data-connections"
import { WorkflowMultiSelectionBar } from "@/features/workflows/workflow-multi-selection-bar"
import { RunNodeOutputPanel } from "@/features/runs/run-node-output-panel"
import { workflowAuthoringStates } from "@/features/workflows/workflow-authoring-state"
import { workflowConnectionIssue } from "@/features/workflows/workflow-connection-validation"
import { WorkflowGroupManager } from "@/features/workflows/workflow-group-manager"
import { WorkflowEntryPanel } from "@/features/workflows/workflow-entry-panel"
import type { WorkflowExpressionFixtures } from "@/features/workflows/workflow-expression-fixtures"
import { autoWorkflowPositions, type WorkflowCanvasLayout, type WorkflowNodePosition } from "@/features/workflows/workflow-layout"
import { elkWorkflowPositions } from "@/features/workflows/workflow-elk-layout"
import { WorkflowNodeAdd } from "@/features/workflows/workflow-node-add"
import { workflowNodePresentations } from "@/features/workflows/workflow-node-catalog"
import {
  workflowEdgeDiagnostics,
  workflowNodeDiagnostics,
  workflowNodeFallbackDiagnostics,
} from "@/features/workflows/workflow-node-diagnostics"
import { WorkflowNodeInspector } from "@/features/workflows/workflow-node-inspector"
import { WorkflowNodeActionsMenu } from "@/features/workflows/workflow-node-actions-menu"
import { workflowExecutionDescription } from "@/features/workflows/workflow-execution-presentation"
import { WorkflowRunOverlayBar } from "@/features/workflows/workflow-run-overlay-bar"
import { useWorkflowRunOverlay } from "@/features/workflows/use-workflow-run-overlay"
import { useWorkflowMultiSelection } from "@/features/workflows/use-workflow-multi-selection"
import { WorkflowTestDataBar, type WorkflowTestDataControls } from "@/features/workflows/workflow-test-data-bar"
import { workflowTestScopeAvailability, type WorkflowTestScopeKind } from "@/features/workflows/workflow-test-scope"
import { duplicateWorkflowNodeOperations } from "@/features/workflows/workflow-node-duplication"
import { WorkflowSettingsInspector } from "@/features/workflows/workflow-settings-inspector"
import {
  workflowSourceOutlineEntries,
  workflowSourceGraph,
  workflowSourceNodes,
  connectWorkflowNodesOperations,
  disconnectWorkflowNodesOperations,
  reconnectWorkflowNodesOperations,
} from "@/features/workflows/workflow-source-model"
import { WorkflowSourceOutline } from "@/features/workflows/workflow-source-outline"
import { cn } from "@/lib/utils"

export function WorkflowDesignView({
  compiled,
  workflowId,
  draftId,
  diagnostics = [],
  source,
  library,
  agents,
  workflows = [],
  adapters,
  routing,
  agentCatalogComplete,
  canvasLayout,
  selectedNodeId,
  canMutate,
  pending,
  onOperations,
  onCanvasLayoutChange,
  expressionFixtures,
  testData,
  onSaveExpressionFixture,
  nodeNotes,
  onSaveNodeNote,
  onSelectNode,
  onTestThroughNode,
  onTestScopedNode,
  focusedDiagnostic,
}: {
  compiled?: CompiledWorkflow
  workflowId: string
  draftId: string
  diagnostics?: DraftValidationResult["diagnostics"]
  source: JsonValue
  library: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
  workflows?: readonly WorkflowSummary[]
  adapters?: InputAdapterCatalog
  routing?: RouterDefinition
  agentCatalogComplete: boolean
  canvasLayout: WorkflowCanvasLayout
  selectedNodeId?: string
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
  onCanvasLayoutChange: (layout: WorkflowCanvasLayout) => void
  expressionFixtures: WorkflowExpressionFixtures
  testData: WorkflowTestDataControls
  onSaveExpressionFixture: (name: string, value: JsonValue) => void
  nodeNotes: Readonly<Record<string, string>>
  onSaveNodeNote: (nodeId: string, note: string) => void
  onSelectNode: (nodeId: string | undefined) => void
  onTestThroughNode: (nodeId: string) => void
  onTestScopedNode: (kind: WorkflowTestScopeKind, nodeId: string) => void
  focusedDiagnostic?: {
    readonly nodeId: string
    readonly fieldPath?: readonly (string | number)[]
  }
}) {
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteAfterNodeId, setPaletteAfterNodeId] = useState<string>()
  const [paletteBeforeNodeId, setPaletteBeforeNodeId] = useState<string>()
  const [copiedNode, setCopiedNode] = useState<Readonly<Record<string, JsonValue>>>()
  const [layoutPending, setLayoutPending] = useState(false)
  const [fitViewRequest, setFitViewRequest] = useState(0)
  const [runOverlayOpen, setRunOverlayOpen] = useState(false)
  const runOverlay = useWorkflowRunOverlay({
    workflowId,
    compiledRevision: compiled?.workflow_revision,
    open: runOverlayOpen,
  })
  const nodes = workflowSourceNodes(source)
  const sourceOutlineEntries = workflowSourceOutlineEntries(source)
  const authoringGraph = workflowSourceGraph(nodes)
  const dataConnections = workflowDataConnections(nodes)
  const presentations = workflowNodePresentations(library.registrations, agents, workflows)
  const nodeDiagnostics = workflowNodeDiagnostics(nodes, diagnostics)
  const edgeDiagnostics = workflowEdgeDiagnostics(diagnostics)
  const compiledIds = new Set(compiled?.nodes.map((node) => node.id) ?? [])
  const authoringStates = workflowAuthoringStates(authoringGraph, compiledIds)
  const selectedSourceEntry = sourceOutlineEntries.find(
    (entry) => entry.selectionId === selectedNodeId,
  )
  const selected = selectedSourceEntry?.node ?? nodes.find((node) => node.id === selectedNodeId)
  const multiSelection = useWorkflowMultiSelection({
    nodes,
    selectedNodeId: selected?.id,
    canMutate,
    pending,
    onOperations,
    onSelectNode,
  })
  const activeTestDataNodeIds = new Set(
    [...testData.nodeStates.entries()].flatMap(([nodeId, state]) =>
      state === "active" ? [nodeId] : []
    ),
  )
  const isolatedTest = selected === undefined
    ? undefined
    : workflowTestScopeAvailability(nodes, selected.id, "isolated_node", activeTestDataNodeIds)
  const fromHereTest = selected === undefined
    ? undefined
    : workflowTestScopeAvailability(nodes, selected.id, "from_node", activeTestDataNodeIds)
  const unavailableReason = (missingNodeIds: readonly string[] | undefined) =>
    missingNodeIds === undefined || missingNodeIds.length === 0
      ? undefined
      : `Ative dados salvos para: ${missingNodeIds.join(", ")}`
  const selectedDiagnostics = selected === undefined
    ? []
    : nodeDiagnostics.get(selected.id) ?? []
  const fallbackDiagnostics = workflowNodeFallbackDiagnostics(selectedDiagnostics)
  const moveNode = (nodeId: string, position: WorkflowNodePosition) => {
    onCanvasLayoutChange({
      ...canvasLayout,
      positions: { ...canvasLayout.positions, [nodeId]: position },
      pinnedNodeIds: [...new Set([...canvasLayout.pinnedNodeIds, nodeId])],
    })
  }
  const toggleSelectedPin = () => {
    if (selected === undefined) return
    const pinned = canvasLayout.pinnedNodeIds.includes(selected.id)
    const fallback = autoWorkflowPositions(authoringGraph)[selected.id]
    onCanvasLayoutChange({
      ...canvasLayout,
      positions: pinned || canvasLayout.positions[selected.id] !== undefined || fallback === undefined
        ? canvasLayout.positions
        : { ...canvasLayout.positions, [selected.id]: fallback },
      pinnedNodeIds: pinned
        ? canvasLayout.pinnedNodeIds.filter((nodeId) => nodeId !== selected.id)
        : [...canvasLayout.pinnedNodeIds, selected.id],
    })
  }
  const applyAutoLayout = async () => {
    setLayoutPending(true)
    try {
      const positions = await elkWorkflowPositions(authoringGraph, canvasLayout)
      onCanvasLayoutChange({ ...canvasLayout, positions })
      setFitViewRequest((current) => current + 1)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível organizar o grafo")
    } finally {
      setLayoutPending(false)
    }
  }
  const connectNodes = (sourceId: string, targetId: string) => {
    const operations = connectWorkflowNodesOperations(nodes, sourceId, targetId)
    if (operations.length > 0) onOperations(operations)
  }
  const disconnectNodes = (sourceId: string, targetId: string) => {
    const operations = disconnectWorkflowNodesOperations(nodes, sourceId, targetId)
    if (operations.length > 0) onOperations(operations)
  }
  const reconnectNodes = (previousSourceId: string, previousTargetId: string, nextSourceId: string, nextTargetId: string) => {
    const operations = reconnectWorkflowNodesOperations(nodes, previousSourceId, previousTargetId, nextSourceId, nextTargetId)
    if (operations.length > 0) onOperations(operations)
  }
  const duplicateNode = useCallback((
    value: Readonly<Record<string, JsonValue>>,
    afterNodeId: string | undefined,
  ) => {
    const duplicate = duplicateWorkflowNodeOperations(nodes, value, afterNodeId)
    if (duplicate === undefined) return
    onOperations(duplicate.operations)
    onSelectNode(duplicate.id)
  }, [nodes, onOperations, onSelectNode])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && (
        target.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      )) return
      if (event.key.toLocaleLowerCase() === "c" && selected !== undefined) {
        event.preventDefault()
        setCopiedNode(selected.value)
      }
      if (
        event.key.toLocaleLowerCase() === "v" &&
        copiedNode !== undefined &&
        canMutate &&
        !pending
      ) {
        event.preventDefault()
        duplicateNode(copiedNode, selected?.id)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [canMutate, copiedNode, duplicateNode, pending, selected])

  return (
    <div className="flex min-h-[calc(100vh-15rem)] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div>
          <p className="text-sm font-medium">Fluxo</p>
          <p className="text-xs text-muted-foreground">Clique ou arraste os pontos para conectar etapas; solte no vazio para adicionar outra.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <WorkflowEntryPanel workflowId={workflowId} adapters={adapters} routing={routing} />
          {selected !== undefined && !multiSelection.hasMultiple && (
            <>
              <Button size="sm" variant="default" onClick={() => onTestThroughNode(selected.id)}>
                <PlayIcon aria-hidden="true" /> Executar até aqui
              </Button>
              <WorkflowNodeActionsMenu
                pinned={canvasLayout.pinnedNodeIds.includes(selected.id)}
                canMutate={canMutate && !pending}
                canPaste={copiedNode !== undefined}
                onCopy={() => setCopiedNode(selected.value)}
                onDuplicate={() => duplicateNode(selected.value, selected.id)}
                onTogglePin={toggleSelectedPin}
                onPaste={() => copiedNode !== undefined && duplicateNode(copiedNode, selected.id)}
                onDelete={() => {
                  multiSelection.deleteSingle()
                }}
                onTestIsolated={() => onTestScopedNode("isolated_node", selected.id)}
                onTestFromHere={() => onTestScopedNode("from_node", selected.id)}
                isolatedTestUnavailableReason={unavailableReason(isolatedTest?.missingNodeIds)}
                fromHereTestUnavailableReason={unavailableReason(fromHereTest?.missingNodeIds)}
                deleteUnavailableReason={multiSelection.singleDeleteUnavailableReason}
              />
            </>
          )}
          {selected === undefined && <Button size="sm" variant="ghost" disabled={copiedNode === undefined || !canMutate || pending} onClick={() => copiedNode !== undefined && duplicateNode(copiedNode, undefined)}>
            <ClipboardPasteIcon aria-hidden="true" /> Colar
          </Button>}
          <Button size="sm" variant={outlineOpen ? "secondary" : "outline"} onClick={() => setOutlineOpen((current) => !current)}>
            <ListTreeIcon aria-hidden="true" /> Passos
          </Button>
          <Button
            size="sm"
            variant={runOverlayOpen ? "secondary" : "outline"}
            onClick={() => setRunOverlayOpen((current) => !current)}
          >
            <HistoryIcon aria-hidden="true" /> Ver execução
          </Button>
          <WorkflowNodeAdd
            source={source}
            nodes={nodes}
            library={library}
            agents={agents}
            workflows={workflows}
            currentWorkflowId={workflowId}
            canMutate={canMutate}
            pending={pending}
            afterNodeId={paletteAfterNodeId ?? selected?.id}
            beforeNodeId={paletteBeforeNodeId}
            open={paletteOpen}
            onOpenChange={(open) => {
              setPaletteOpen(open)
              if (!open) {
                setPaletteAfterNodeId(undefined)
                setPaletteBeforeNodeId(undefined)
              }
            }}
            onOperations={onOperations}
            onAdded={onSelectNode}
          />
          <WorkflowGroupManager
            groups={canvasLayout.groups}
            nodes={nodes.map((node) => ({ id: node.id, title: presentations.get(`${node.type}:${node.registrationId}`)?.title ?? node.id }))}
            disabled={!canMutate || pending}
            onChange={(groups) => onCanvasLayoutChange({ ...canvasLayout, groups })}
          />
          <NativeSelect
            aria-label="Direção do layout"
            value={canvasLayout.direction}
            disabled={!canMutate || pending || layoutPending}
            onChange={(event) => onCanvasLayoutChange({ ...canvasLayout, direction: event.target.value === "horizontal" ? "horizontal" : "vertical" })}
          >
            <NativeSelectOption value="vertical">Vertical</NativeSelectOption>
            <NativeSelectOption value="horizontal">Horizontal</NativeSelectOption>
          </NativeSelect>
          <Button size="sm" variant="outline" disabled={!canMutate || pending || layoutPending || nodes.length === 0} onClick={() => void applyAutoLayout()}>
            <WandSparklesIcon aria-hidden="true" /> {layoutPending ? "Organizando…" : "Organizar"}
          </Button>
          {canvasLayout.pinnedNodeIds.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!canMutate || pending}
              onClick={() => onCanvasLayoutChange({ ...canvasLayout, pinnedNodeIds: [] })}
            >
              <PinOffIcon aria-hidden="true" /> Liberar todos
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
            <Settings2Icon aria-hidden="true" /> Avançado
          </Button>
        </div>
      </div>
      <WorkflowTestDataBar controls={testData} />
      {runOverlayOpen && (
        <WorkflowRunOverlayBar state={runOverlay} onClose={() => setRunOverlayOpen(false)} />
      )}
      <div className={cn(
        "grid min-h-0 flex-1 grid-cols-1",
        outlineOpen && selected !== undefined && "xl:grid-cols-[17rem_minmax(30rem,1fr)_22rem]",
        outlineOpen && selected === undefined && "xl:grid-cols-[17rem_minmax(30rem,1fr)]",
        !outlineOpen && selected !== undefined && "xl:grid-cols-[minmax(30rem,1fr)_22rem]",
      )}>
        {outlineOpen && <aside className="border-b p-3 xl:border-r xl:border-b-0" aria-label="Outline do workflow">
          <h2 className="mb-1 text-sm font-medium">Outline</h2>
          <p className="mb-3 text-xs text-muted-foreground">Navegue pelos passos também por teclado.</p>
          <ScrollArea className="max-h-80 xl:max-h-[calc(100vh-20rem)]">
            <WorkflowSourceOutline entries={sourceOutlineEntries} selectedEntryId={selectedNodeId} onSelectEntry={onSelectNode} />
            {sourceOutlineEntries.length === 0 && <p className="p-2 text-xs text-muted-foreground">Nenhum node. Use “Adicionar node”.</p>}
          </ScrollArea>
        </aside>}
        <section className="relative min-h-96 border-b bg-muted/20 xl:border-r xl:border-b-0">
          <div className="absolute top-3 left-3 z-10 rounded-lg border bg-background/95 px-2 py-1 text-xs text-muted-foreground shadow-sm">
            {compiled === undefined ? "Rascunho visual · conecte os passos arrastando os pontos" : "Workflow compilado · conexões editam as dependências"}
          </div>
          {multiSelection.hasMultiple && <WorkflowMultiSelectionBar
            count={multiSelection.selectedNodeIds.length}
            canDelete={multiSelection.canDeleteMultiple}
            deleteUnavailableReason={multiSelection.deleteUnavailableReason}
            deleteOpen={multiSelection.deleteOpen}
            onDeleteOpenChange={multiSelection.setDeleteOpen}
            onClear={multiSelection.clear}
            onDelete={multiSelection.deleteMultiple}
          />}
          <WorkflowGraph
            graph={authoringGraph}
            dataConnections={dataConnections}
            execution={runOverlayOpen && runOverlay.overlay.kind === "compatible"
              ? runOverlay.overlay.execution
              : undefined}
            presentations={presentations}
            diagnostics={nodeDiagnostics}
            edgeDiagnostics={edgeDiagnostics}
            authoringStates={authoringStates}
            testData={testData.nodeStates}
            positions={canvasLayout.positions}
            direction={canvasLayout.direction}
            groups={canvasLayout.groups}
            fitViewRequest={fitViewRequest}
            onAddFirstNode={canMutate && !pending ? () => setPaletteOpen(true) : undefined}
            canMove={canMutate && !pending}
            selectedNodeId={selectedNodeId}
            selectedNodeIds={multiSelection.selectedNodeIds}
            onMoveNode={moveNode}
            onSelectNode={(id, additive) => id === ""
              ? multiSelection.clear()
              : multiSelection.select(id, additive)}
            onConnectNodes={canMutate && !pending ? connectNodes : undefined}
            onConnectToEmpty={canMutate && !pending ? (sourceId) => {
              setPaletteAfterNodeId(sourceId)
              setPaletteOpen(true)
            } : undefined}
            onInsertDependency={canMutate && !pending ? (sourceId, targetId) => {
              setPaletteAfterNodeId(sourceId)
              setPaletteBeforeNodeId(targetId)
              setPaletteOpen(true)
            } : undefined}
            onDeleteDependency={canMutate && !pending ? disconnectNodes : undefined}
            onReconnectDependency={canMutate && !pending ? reconnectNodes : undefined}
            isValidConnection={(sourceId, targetId) =>
              workflowConnectionIssue(
                nodes,
                authoringGraph.edges,
                sourceId,
                targetId,
                library.registrations,
              ) === undefined
            }
            onInvalidConnection={(sourceId, targetId) => {
              toast.error(
                workflowConnectionIssue(
                  nodes,
                  authoringGraph.edges,
                  sourceId,
                  targetId,
                  library.registrations,
                ) ??
                "Não foi possível conectar esses passos.",
              )
            }}
          />
        </section>
        {(selected !== undefined || selectedSourceEntry !== undefined) && <aside className="relative max-h-[calc(100vh-15rem)] overflow-y-auto border-l p-4" aria-label="Inspector do node">
          <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" onClick={() => onSelectNode(undefined)}>
            <XIcon aria-hidden="true" /><span className="sr-only">Fechar inspector</span>
          </Button>
          <h2 className="pr-8 text-sm font-medium">{selectedSourceEntry !== undefined && selected === undefined ? "Passo inválido" : "Configurar passo"}</h2>
          {selectedSourceEntry !== undefined && selected === undefined ? (
            <div className="mt-4 space-y-4" role="status">
              <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3">
                <p className="text-sm font-medium">Este item continua acessível, mas não é um node estruturado válido.</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {selectedSourceEntry.problems.map((problem) => <li key={problem}>{problem}</li>)}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">Corrija a estrutura no Raw fallback e valide novamente pelo servidor.</p>
              </div>
              <section>
                <h3 className="mb-2 text-xs font-medium">Valor bruto do item {selectedSourceEntry.index + 1}</h3>
                <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(selectedSourceEntry.raw, null, 2)}</pre>
              </section>
            </div>
          ) : selected !== undefined ? (
            <div className="mt-4 space-y-4">
              {runOverlayOpen && runOverlay.overlay.kind === "compatible" && runOverlay.selectedRunId !== undefined && (
                <section className="space-y-2 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
                  <div>
                    <p className="text-sm font-medium">Resultado da execução exibida</p>
                    <p className="text-xs text-muted-foreground">
                      {workflowExecutionDescription(runOverlay.overlay.execution.get(selected.id))}
                    </p>
                  </div>
                  <RunNodeOutputPanel
                    runId={runOverlay.selectedRunId}
                    nodeId={selected.id}
                    draftId={draftId}
                  />
                </section>
              )}
              {fallbackDiagnostics.length > 0 && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3" role="status">
                  <p className="text-sm font-medium">Corrija este passo</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    {fallbackDiagnostics.map((diagnostic) => (
                      <li key={`${diagnostic.severity}:${diagnostic.message}`}>{diagnostic.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              {selectedSourceEntry !== undefined && selectedSourceEntry.problems.length > 0 && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-xs text-muted-foreground" role="status">
                  {selectedSourceEntry.problems.join(" ")}
                </div>
              )}
              <WorkflowNodeInspector
                source={source}
                nodes={nodes}
                selected={selected}
                library={library}
                agents={agents}
                workflows={workflows.filter((workflow) => workflow.id !== workflowId)}
                canMutate={canMutate}
                pending={pending}
                onOperations={onOperations}
                expressionFixtures={expressionFixtures}
                activeExpressionFixtureName={testData.previewFixtureName}
                onSaveExpressionFixture={onSaveExpressionFixture}
                onRemoveExpressionFixture={testData.onRemove}
                onSelectExpressionFixture={(name) => {
                  const entry = testData.entries.find((candidate) => candidate.name === name)
                  if (entry !== undefined) testData.onPreview(entry)
                }}
                note={nodeNotes[selected.id] ?? ""}
                onSaveNote={(note) => onSaveNodeNote(selected.id, note)}
                diagnostics={selectedDiagnostics}
                focusedFieldPath={focusedDiagnostic?.nodeId === selected.id
                  ? focusedDiagnostic.fieldPath
                  : undefined}
              />
            </div>
          ) : null}
        </aside>}
      </div>
      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Configurações avançadas do workflow</SheetTitle>
            <SheetDescription>Autoridade, capabilities, runtime e representação técnica.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <WorkflowSettingsInspector source={source} library={library} agents={agents} agentCatalogComplete={agentCatalogComplete} canMutate={canMutate} pending={pending} onOperations={onOperations} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
