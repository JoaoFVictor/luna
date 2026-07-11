import { useCallback, useEffect, useMemo, useState } from "react"
import { ClipboardPasteIcon, CopyIcon, FilesIcon, ListTreeIcon, PinIcon, PinOffIcon, PlayIcon, Settings2Icon, WandSparklesIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import type {
  AgentCatalogItem,
  CapabilityCatalog,
  CompiledWorkflow,
  DraftValidationResult,
  InputAdapterCatalog,
  JsonValue,
  RouterDefinition,
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
import { WorkflowGroupManager } from "@/features/workflows/workflow-group-manager"
import { WorkflowEntryPanel } from "@/features/workflows/workflow-entry-panel"
import type { WorkflowExpressionFixtures } from "@/features/workflows/workflow-expression-fixtures"
import { autoWorkflowPositions, type WorkflowCanvasLayout, type WorkflowNodePosition } from "@/features/workflows/workflow-layout"
import { elkWorkflowPositions } from "@/features/workflows/workflow-elk-layout"
import { WorkflowNodeAdd } from "@/features/workflows/workflow-node-add"
import { workflowNodePresentations } from "@/features/workflows/workflow-node-catalog"
import { workflowEdgeDiagnostics, workflowNodeDiagnostics } from "@/features/workflows/workflow-node-diagnostics"
import { WorkflowNodeInspector } from "@/features/workflows/workflow-node-inspector"
import { duplicateWorkflowNodeOperations } from "@/features/workflows/workflow-node-duplication"
import { WorkflowSettingsInspector } from "@/features/workflows/workflow-settings-inspector"
import {
  workflowSourceOutlineEntries,
  workflowSourceGraph,
  workflowSourceNodes,
  connectWorkflowNodesOperations,
  disconnectWorkflowNodesOperations,
  reconnectWorkflowNodesOperations,
  workflowDependencyWouldCycle,
} from "@/features/workflows/workflow-source-model"
import { WorkflowSourceOutline } from "@/features/workflows/workflow-source-outline"
import { cn } from "@/lib/utils"

export function WorkflowDesignView({
  compiled,
  workflowId,
  diagnostics = [],
  source,
  library,
  agents,
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
  onSaveExpressionFixture,
  onRemoveExpressionFixture,
  nodeNotes,
  onSaveNodeNote,
  onSelectNode,
  onTestThroughNode,
}: {
  compiled?: CompiledWorkflow
  workflowId: string
  diagnostics?: DraftValidationResult["diagnostics"]
  source: JsonValue
  library: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
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
  onSaveExpressionFixture: (name: string, value: JsonValue) => void
  onRemoveExpressionFixture: (name: string) => void
  nodeNotes: Readonly<Record<string, string>>
  onSaveNodeNote: (nodeId: string, note: string) => void
  onSelectNode: (nodeId: string | undefined) => void
  onTestThroughNode: (nodeId: string) => void
}) {
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteAfterNodeId, setPaletteAfterNodeId] = useState<string>()
  const [paletteBeforeNodeId, setPaletteBeforeNodeId] = useState<string>()
  const [copiedNode, setCopiedNode] = useState<Readonly<Record<string, JsonValue>>>()
  const [layoutPending, setLayoutPending] = useState(false)
  const nodes = workflowSourceNodes(source)
  const sourceOutlineEntries = workflowSourceOutlineEntries(source)
  const authoringGraph = workflowSourceGraph(nodes)
  const presentations = workflowNodePresentations(library.registrations, agents)
  const nodeDiagnostics = workflowNodeDiagnostics(nodes, diagnostics)
  const edgeDiagnostics = workflowEdgeDiagnostics(diagnostics)
  const authoringStates = useMemo(() => {
    const compiledIds = new Set(compiled?.nodes.map((node) => node.id) ?? [])
    return new Map(nodes.map((node) => [
      node.id,
      compiledIds.has(node.id) ? "ready" as const : "unchecked" as const,
    ]))
  }, [compiled, nodes])
  const selectedSourceEntry = sourceOutlineEntries.find(
    (entry) => entry.selectionId === selectedNodeId,
  )
  const selected = selectedSourceEntry?.node ?? nodes.find((node) => node.id === selectedNodeId)
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
          <p className="text-xs text-muted-foreground">Arraste os pontos para conectar etapas ou solte no vazio para adicionar outra.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <WorkflowEntryPanel workflowId={workflowId} adapters={adapters} routing={routing} />
          {selected !== undefined && (
            <>
              <Button size="sm" variant="default" onClick={() => onTestThroughNode(selected.id)}>
                <PlayIcon aria-hidden="true" /> Executar até aqui
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCopiedNode(selected.value)}>
                <CopyIcon aria-hidden="true" /> Copiar
              </Button>
              <Button size="sm" variant="ghost" disabled={!canMutate || pending} onClick={() => duplicateNode(selected.value, selected.id)}>
                <FilesIcon aria-hidden="true" /> Duplicar
              </Button>
              <Button size="sm" variant="ghost" disabled={!canMutate || pending} onClick={toggleSelectedPin}>
                {canvasLayout.pinnedNodeIds.includes(selected.id) ? <PinOffIcon aria-hidden="true" /> : <PinIcon aria-hidden="true" />}
                {canvasLayout.pinnedNodeIds.includes(selected.id) ? "Liberar posição" : "Fixar posição"}
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" disabled={copiedNode === undefined || !canMutate || pending} onClick={() => copiedNode !== undefined && duplicateNode(copiedNode, selected?.id)}>
            <ClipboardPasteIcon aria-hidden="true" /> Colar
          </Button>
          <Button size="sm" variant={outlineOpen ? "secondary" : "outline"} onClick={() => setOutlineOpen((current) => !current)}>
            <ListTreeIcon aria-hidden="true" /> Passos
          </Button>
          <WorkflowNodeAdd
            source={source}
            nodes={nodes}
            library={library}
            agents={agents}
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
          <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
            <Settings2Icon aria-hidden="true" /> Avançado
          </Button>
        </div>
      </div>
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
          <WorkflowGraph
            graph={authoringGraph}
            presentations={presentations}
            diagnostics={nodeDiagnostics}
            edgeDiagnostics={edgeDiagnostics}
            authoringStates={authoringStates}
            positions={canvasLayout.positions}
            direction={canvasLayout.direction}
            groups={canvasLayout.groups}
            canMove={canMutate && !pending}
            selectedNodeId={selectedNodeId}
            onMoveNode={moveNode}
            onSelectNode={(id) => onSelectNode(id || undefined)}
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
              sourceId !== targetId &&
              !authoringGraph.edges.some((edge) => edge.from === sourceId && edge.to === targetId) &&
              !workflowDependencyWouldCycle(nodes, targetId, sourceId)
            }
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
              {(nodeDiagnostics.get(selected.id)?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3" role="status">
                  <p className="text-sm font-medium">Corrija este passo</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    {nodeDiagnostics.get(selected.id)?.map((diagnostic) => (
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
                canMutate={canMutate}
                pending={pending}
                onOperations={onOperations}
                expressionFixtures={expressionFixtures}
                onSaveExpressionFixture={onSaveExpressionFixture}
                onRemoveExpressionFixture={onRemoveExpressionFixture}
                note={nodeNotes[selected.id] ?? ""}
                onSaveNote={(note) => onSaveNodeNote(selected.id, note)}
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
