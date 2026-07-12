import type {
  AgentCatalogItem,
  CapabilityCatalog,
  JsonValue,
  YamlSourceOperation,
} from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { WorkflowJsonField } from "@/features/workflows/workflow-json-field"
import {
  workflowSourceCapabilities,
  workflowSourceNodes,
} from "@/features/workflows/workflow-source-model"
import { workflowSideEffectPreview } from "@/features/workflows/workflow-side-effect-preview"

function rootField(source: JsonValue, field: string): JsonValue | undefined {
  return source !== null && typeof source === "object" && !Array.isArray(source)
    ? source[field]
    : undefined
}

export function WorkflowSettingsInspector({
  source,
  library,
  agents,
  agentCatalogComplete,
  canMutate,
  pending,
  onOperations,
}: {
  source: JsonValue
  library: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
  agentCatalogComplete: boolean
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
}) {
  const capabilities = workflowSourceCapabilities(source)
  const nodes = workflowSourceNodes(source)
  const mode = rootField(source, "mode")
  const repositoryAccess = mode === "trusted_local_write"
    ? "trusted_local_write"
    : mode === undefined || mode === "read_only"
      ? "read_only"
      : "inválido"
  const sideEffects = workflowSideEffectPreview(
    source,
    library,
    agents,
    agentCatalogComplete,
  )
  return (
    <div className="mt-4 space-y-5 text-sm">
      <Field>
        <FieldLabel>Postura de acesso e efeitos</FieldLabel>
        <FieldDescription>
          Acesso ao repositório e efeitos externos são dimensões separadas; <code>read_only</code> não garante ausência de publicação externa.
        </FieldDescription>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">repositório: {repositoryAccess}</Badge>
          {sideEffects.length === 0
            ? <Badge variant="outline">efeitos externos declarados: nenhum</Badge>
            : sideEffects.map((effect) => (
                <Badge key={`${effect.nodeId}:${effect.source}:${effect.description}`} variant="outline" className="border-destructive/50 text-foreground">
                  {effect.nodeId}: {effect.semantics} {effect.operationIds.join(", ") || effect.description}
                </Badge>
              ))}
        </div>
      </Field>

      <details className="rounded-lg border">
        <summary className="cursor-pointer px-3 py-2 font-medium">Representação técnica</summary>
        <div className="space-y-5 border-t p-3">
      <Field>
        <FieldLabel>Capabilities declaradas</FieldLabel>
        <FieldDescription>
          IDs não qualificados habilitam registrations; cada <code>uses</code> continua sendo uma referência namespaced separada.
        </FieldDescription>
        <div className="flex flex-wrap gap-1.5">
          {capabilities.map((capabilityId) => {
            const known = library.capabilities.some((item) => item.id === capabilityId)
            return (
              <Badge
                key={capabilityId}
                variant="outline"
                className={known ? undefined : "border-destructive/50 text-foreground"}
              >
                {capabilityId}{known ? "" : " (desconhecida)"}
              </Badge>
            )
          })}
          {capabilities.length === 0 && <span className="text-xs text-muted-foreground">Nenhuma capability declarada.</span>}
        </div>
      </Field>

      <Field>
        <FieldLabel>Registrations usadas</FieldLabel>
        <div className="flex flex-wrap gap-1.5">
          {nodes.map((node) => <Badge key={`${node.id}:${node.registrationId}`} variant="secondary">{node.registrationId}</Badge>)}
          {nodes.length === 0 && <span className="text-xs text-muted-foreground">Nenhuma registration usada.</span>}
        </div>
      </Field>

      <WorkflowJsonField label="Capabilities (avançado)" description="Adicionar ou remover aqui gera uma mutação explícita e aparece no Diff." path={["capabilities"]} value={rootField(source, "capabilities")} canMutate={canMutate} pending={pending} onOperations={onOperations} />
      <WorkflowJsonField label="Requires" description="Requisitos do workflow, como repository, sem inferência por workflow id." path={["requires"]} value={rootField(source, "requires")} canMutate={canMutate} pending={pending} onOperations={onOperations} />
      <WorkflowJsonField label="Config declaration" description="Contrato de config; valores não classificados continuam fora desta surface." path={["config"]} value={rootField(source, "config")} canMutate={canMutate} pending={pending} onOperations={onOperations} />
      <WorkflowJsonField label="Execution" path={["execution"]} value={rootField(source, "execution")} canMutate={canMutate} pending={pending} onOperations={onOperations} />
      <WorkflowJsonField label="Observability" path={["observability"]} value={rootField(source, "observability")} canMutate={canMutate} pending={pending} onOperations={onOperations} />
      <WorkflowJsonField label="Subagent policy" path={["subagent_policy"]} value={rootField(source, "subagent_policy")} canMutate={canMutate} pending={pending} onOperations={onOperations} />
        </div>
      </details>
    </div>
  )
}
