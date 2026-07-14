import type {
  AgentCatalogItem,
  CapabilityCatalog,
  JsonValue,
  WorkflowSummary,
} from "@/api/types"
import { Badge } from "@/components/ui/badge"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

function SchemaDetails({ label, schema }: { label: string; schema: JsonValue }) {
  return (
    <details className="rounded-lg border p-2">
      <summary className="cursor-pointer text-xs font-medium">{label}</summary>
      <pre className="mt-2 max-h-48 overflow-auto text-xs">{JSON.stringify(schema, null, 2)}</pre>
    </details>
  )
}

export function WorkflowNodeContractSummary({
  node,
  library,
  agents,
  workflows = [],
}: {
  node: WorkflowSourceNode
  library: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
  workflows?: readonly WorkflowSummary[]
}) {
  if (node.type === "loop") {
    return (
      <div className="flex flex-wrap gap-1">
        <Badge variant="secondary">Loop durável</Badge>
        <Badge variant="outline">body com checkpoint próprio</Badge>
      </div>
    )
  }
  if (node.type === "agent") {
    const agent = agents.find((candidate) => candidate.id === node.registrationId)
    if (agent === undefined) return <p className="text-xs text-destructive">Agent ausente no catálogo canônico.</p>
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline">mode: {agent.mode}</Badge>
          {agent.runtime_requirements.map((item) => <Badge key={item} variant="secondary">{item}</Badge>)}
        </div>
        <SchemaDetails label="Output contract do agent" schema={agent.output_schema} />
      </div>
    )
  }
  if (node.type === "workflow") {
    const workflow = workflows.find((candidate) => candidate.id === node.registrationId)
    if (workflow === undefined) {
      return <p className="text-xs text-destructive">Workflow filho ausente no catálogo canônico.</p>
    }
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1">
          <Badge variant="secondary">Subworkflow</Badge>
          <Badge variant="outline">mode: {workflow.mode}</Badge>
          <Badge variant="outline">revision: {workflow.revision.slice(0, 15)}</Badge>
        </div>
        <SchemaDetails label="Input contract do workflow filho" schema={workflow.input_schema_content} />
        <SchemaDetails label="Output contract do workflow filho" schema={workflow.output_schema_content} />
      </div>
    )
  }

  const registration = library.registrations.find(
    (candidate) => candidate.id === node.registrationId,
  )
  if (registration === undefined) {
    return <p className="text-xs text-destructive">Registration ausente na Library carregada.</p>
  }
  if (registration.registration_kind === "built_in") {
    const policy = registration.side_effect_policy === undefined
      ? undefined
      : library.registrations.find(
          (candidate) => candidate.registration_kind === "policy" && candidate.id === registration.side_effect_policy,
        )
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1">
          {registration.required_ports.map((port) => <Badge key={port} variant="secondary">port: {port}</Badge>)}
          {policy?.registration_kind === "policy" && <Badge variant="outline" className="border-destructive/50 text-foreground">{policy.side_effect_semantics ?? "unknown"}: {policy.side_effect_operation_ids.join(", ") || "operação desconhecida"}</Badge>}
        </div>
        <SchemaDetails label="Input contract" schema={registration.input_schema} />
        <SchemaDetails label="Output contract" schema={registration.output_schema} />
      </div>
    )
  }
  if (registration.registration_kind === "pattern") {
    return (
      <div className="space-y-2">
        <SchemaDetails label="Input contract" schema={registration.input_schema} />
        <SchemaDetails label="Output contract" schema={registration.output_schema} />
      </div>
    )
  }
  if (registration.registration_kind === "gate") {
    return (
      <div className="space-y-2">
        <Badge variant="outline">interrupt: {registration.interrupt}</Badge>
        <SchemaDetails label="Input contract" schema={registration.input_schema} />
        <SchemaDetails label="Decision contract" schema={registration.decision_schema} />
        <SchemaDetails label="Output contract" schema={registration.output_schema} />
      </div>
    )
  }
  return <p className="text-xs text-destructive">A registration não é compatível com este tipo de node.</p>
}
