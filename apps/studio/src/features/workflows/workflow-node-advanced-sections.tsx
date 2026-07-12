import type { CapabilityCatalog, JsonValue, YamlSourceOperation } from "@/api/types"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { WorkflowJsonField } from "./workflow-json-field"
import { WorkflowNodeDeleteControl } from "./workflow-node-refactor-controls"
import { WorkflowNodeResourcesEditor } from "./workflow-node-resources-editor"
import { workflowDependencyWouldCycle, workflowNodeField, type WorkflowSourceNode } from "./workflow-source-model"

type SharedProps = {
  source: JsonValue
  nodes: readonly WorkflowSourceNode[]
  selected: WorkflowSourceNode
  library: CapabilityCatalog
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
}

export function WorkflowNodeDependencies({ nodes, selected, dependencies, canMutate, pending, onToggle }: Omit<SharedProps, "source" | "library" | "onOperations"> & {
  dependencies: readonly string[]
  onToggle: (nodeId: string, checked: boolean) => void
}) {
  return <details className="rounded-lg border"><summary className="cursor-pointer px-3 py-2 text-sm font-medium">Dependências avançadas</summary><div className="border-t p-3">
    <Field><FieldLabel>Passos anteriores</FieldLabel><FieldDescription>Normalmente você conecta os passos no canvas. Use esta lista para ajustes precisos.</FieldDescription>
      <div className="space-y-2 rounded-lg border p-3">
        {nodes.filter((node) => node.id !== selected.id).map((node) => {
          const selectedDependency = dependencies.includes(node.id)
          const wouldCycle = !selectedDependency && workflowDependencyWouldCycle(nodes, selected.id, node.id)
          return <label key={node.id} className="flex items-center gap-2"><Checkbox checked={selectedDependency} disabled={!canMutate || pending || wouldCycle} onCheckedChange={(checked) => onToggle(node.id, checked === true)} /><span className="font-mono text-xs">{node.id}{wouldCycle && <span className="font-sans text-foreground"> (criaria ciclo)</span>}</span></label>
        })}
        {nodes.length === 1 && <span className="text-xs text-muted-foreground">Nenhum outro passo.</span>}
      </div>
    </Field>
  </div></details>
}

export function WorkflowNodeAdvancedFields(props: SharedProps) {
  const { source, nodes, selected, library, canMutate, pending, onOperations } = props
  const field = (label: string, key: string, description?: string) => <WorkflowJsonField label={label} {...(description === undefined ? {} : { description })} path={["nodes", selected.index, key]} value={workflowNodeField(selected, key)} canMutate={canMutate} pending={pending} onOperations={onOperations} />
  return <details className="rounded-lg border"><summary className="cursor-pointer px-3 py-2 text-sm font-medium">Policies, tentativas, runtime e JSON</summary><div className="space-y-5 border-t p-3">
    {field("Entrada JSON avançada", "input", "Visão bruta sincronizada para objetos que não cabem no builder.")}
    {selected.type === "agent" && <>{field("Tentativas", "retry", "Política de novas tentativas deste passo.")}{field("Requisitos de runtime", "runtime_requirements")}</>}
    {selected.type === "pattern" && <>{field("Reparo", "repair", "O reparo pertence ao pattern, não ao agent reutilizável.")}{field("Capabilities locais", "capabilities")}</>}
    {selected.type === "human_gate" && field("Decisão", "decision", "Configuração do ponto de decisão; aprovação remota não é executada por esta UI.")}
    <WorkflowNodeResourcesEditor source={source} selected={selected} library={library} canMutate={canMutate} pending={pending} onOperations={onOperations} />
    <WorkflowNodeDeleteControl nodes={nodes} selected={selected} canMutate={canMutate} pending={pending} onOperations={onOperations} />
  </div></details>
}
