import { Settings2Icon, WandSparklesIcon } from "lucide-react"

import type {
  AgentCatalogItem,
  CapabilityCatalog,
  CompiledWorkflow,
  JsonValue,
  YamlSourceOperation,
} from "@/api/types"
import { PageEmpty } from "@/components/page-state"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { WorkflowGraph, WorkflowOutline } from "@/features/workflows/workflow-graph"
import type { WorkflowExpressionFixtures } from "@/features/workflows/workflow-expression-fixtures"
import {
  autoWorkflowPositions,
  type WorkflowNodePosition,
  type WorkflowPositions,
} from "@/features/workflows/workflow-layout"
import { WorkflowNodeAdd } from "@/features/workflows/workflow-node-add"
import { WorkflowNodeInspector } from "@/features/workflows/workflow-node-inspector"
import { WorkflowSettingsInspector } from "@/features/workflows/workflow-settings-inspector"
import {
  workflowSourceOutlineEntries,
  workflowSourceNodes,
} from "@/features/workflows/workflow-source-model"
import { WorkflowSourceOutline } from "@/features/workflows/workflow-source-outline"

export function WorkflowDesignView({
  compiled,
  source,
  library,
  agents,
  agentCatalogComplete,
  positions,
  selectedNodeId,
  canMutate,
  pending,
  canCompile,
  onCompile,
  onOperations,
  onPositionsChange,
  expressionFixtures,
  onSaveExpressionFixture,
  onRemoveExpressionFixture,
  onSelectNode,
}: {
  compiled?: CompiledWorkflow
  source: JsonValue
  library: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
  agentCatalogComplete: boolean
  positions: WorkflowPositions
  selectedNodeId?: string
  canMutate: boolean
  pending: boolean
  canCompile: boolean
  onCompile: () => void
  onOperations: (operations: readonly YamlSourceOperation[]) => void
  onPositionsChange: (positions: WorkflowPositions) => void
  expressionFixtures: WorkflowExpressionFixtures
  onSaveExpressionFixture: (name: string, value: JsonValue) => void
  onRemoveExpressionFixture: (name: string) => void
  onSelectNode: (nodeId: string | undefined) => void
}) {
  const nodes = workflowSourceNodes(source)
  const sourceOutlineEntries = workflowSourceOutlineEntries(source)
  const selectedSourceEntry = compiled === undefined
    ? sourceOutlineEntries.find((entry) => entry.selectionId === selectedNodeId)
    : undefined
  const selected = selectedSourceEntry?.node ?? nodes.find((node) => node.id === selectedNodeId)
  const moveNode = (nodeId: string, position: WorkflowNodePosition) => {
    onPositionsChange({ ...positions, [nodeId]: position })
  }

  return (
    <div className="flex min-h-[calc(100vh-15rem)] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div>
          <p className="text-sm font-medium">Editor estruturado</p>
          <p className="text-xs text-muted-foreground">YAML é mutado e compilado somente pelo servidor.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onSelectNode(undefined)}>
            <Settings2Icon aria-hidden="true" /> Workflow
          </Button>
          <WorkflowNodeAdd source={source} nodes={nodes} library={library} agents={agents} canMutate={canMutate} pending={pending} onOperations={onOperations} />
          <Button size="sm" variant="outline" disabled={!canMutate || pending || compiled === undefined} onClick={() => compiled !== undefined && onPositionsChange(autoWorkflowPositions(compiled))}>
            <WandSparklesIcon aria-hidden="true" /> Auto-layout
          </Button>
          <Button size="sm" variant="outline" disabled={!canCompile || pending} onClick={onCompile}>Compilar</Button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[17rem_minmax(30rem,1fr)_22rem]">
        <aside className="border-b p-3 xl:border-r xl:border-b-0" aria-label="Outline do workflow">
          <h2 className="mb-1 text-sm font-medium">Outline</h2>
          <p className="mb-3 text-xs text-muted-foreground">Completo por teclado, inclusive quando a fonte ainda é inválida.</p>
          <ScrollArea className="max-h-80 xl:max-h-[calc(100vh-20rem)]">
            {compiled === undefined ? (
              <WorkflowSourceOutline entries={sourceOutlineEntries} selectedEntryId={selectedNodeId} onSelectEntry={onSelectNode} />
            ) : (
              <WorkflowOutline compiled={compiled} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
            )}
            {sourceOutlineEntries.length === 0 && <p className="p-2 text-xs text-muted-foreground">Nenhum node. Use “Adicionar node”.</p>}
          </ScrollArea>
        </aside>
        <section className="relative min-h-96 border-b bg-muted/20 xl:border-r xl:border-b-0">
          {compiled === undefined ? (
            <div className="p-6">
              <PageEmpty
                title="DAG ainda não compilada"
                description="Você pode adicionar e corrigir nodes pelo outline/inspector. O canvas aparece após o compiler real aceitar o workflow."
                action={<Button disabled={!canCompile || pending} onClick={onCompile}>Compilar workflow</Button>}
              />
            </div>
          ) : (
            <>
              <div className="absolute top-3 left-3 z-10 rounded-lg border bg-background/95 px-2 py-1 text-xs text-muted-foreground shadow-sm">Arestas sólidas = <code>after</code>. Arraste nodes para persistir o layout sidecar.</div>
              <WorkflowGraph compiled={compiled} positions={positions} canMove={canMutate && !pending} selectedNodeId={selectedNodeId} onMoveNode={moveNode} onSelectNode={(id) => onSelectNode(id || undefined)} />
            </>
          )}
        </section>
        <aside className="overflow-y-auto p-4" aria-label="Inspector do node">
          <h2 className="text-sm font-medium">{selectedSourceEntry !== undefined && selected === undefined ? "Node inválido" : selected === undefined ? "Workflow" : "Inspector"}</h2>
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
          ) : selected === undefined ? (
            <WorkflowSettingsInspector source={source} library={library} agents={agents} agentCatalogComplete={agentCatalogComplete} canMutate={canMutate} pending={pending} onOperations={onOperations} />
          ) : (
            <div className="mt-4 space-y-4">
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
              />
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
