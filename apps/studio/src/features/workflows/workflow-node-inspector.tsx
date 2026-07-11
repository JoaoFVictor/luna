import { useMemo } from "react"

import type {
  AgentCatalogItem,
  CapabilityCatalog,
  JsonValue,
  YamlSourceOperation,
} from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Separator } from "@/components/ui/separator"
import { WorkflowExpressionBuilder } from "@/features/workflows/workflow-expression-builder"
import type { WorkflowExpressionFixtures } from "@/features/workflows/workflow-expression-fixtures"
import { WorkflowJsonField } from "@/features/workflows/workflow-json-field"
import {
  reconcileWorkflowBuiltInPolicies,
  workflowAgentCapabilityIds,
  workflowBuiltInPolicyEntry,
  workflowNodeRegistrations,
} from "@/features/workflows/workflow-node-catalog"
import { WorkflowNodeContractSummary } from "@/features/workflows/workflow-node-contract-summary"
import {
  WorkflowNodeDeleteControl,
  WorkflowNodeIdentityEditor,
} from "@/features/workflows/workflow-node-refactor-controls"
import { WorkflowNodeResourcesEditor } from "@/features/workflows/workflow-node-resources-editor"
import {
  addWorkflowCapabilityOperations,
  workflowDependencyWouldCycle,
  workflowNodeField,
  type WorkflowSourceNode,
} from "@/features/workflows/workflow-source-model"

export function WorkflowNodeInspector({
  source,
  nodes,
  selected,
  library,
  agents,
  canMutate,
  pending,
  onOperations,
  expressionFixtures,
  onSaveExpressionFixture,
  onRemoveExpressionFixture,
}: {
  source: JsonValue
  nodes: readonly WorkflowSourceNode[]
  selected: WorkflowSourceNode
  library: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
  expressionFixtures: WorkflowExpressionFixtures
  onSaveExpressionFixture: (name: string, value: JsonValue) => void
  onRemoveExpressionFixture: (name: string) => void
}) {
  const registrations = useMemo(
    () => workflowNodeRegistrations(library.registrations, selected.type),
    [library, selected],
  )
  const selectedRegistration = library.registrations.find(
    (registration) => registration.id === selected.registrationId,
  )
  const after = workflowNodeField(selected, "after")
  const dependencies = Array.isArray(after)
    ? after.filter((value): value is string => typeof value === "string")
    : []
  const policyValue = workflowNodeField(selected, "policies")
  const policies = Array.isArray(policyValue) ? policyValue : []

  const changeRegistration = (registrationId: string) => {
    if (selected.type === "agent") {
      const agent = agents.find((candidate) => candidate.id === registrationId)
      const agentCapabilities = workflowAgentCapabilityIds(
        library.capabilities,
        library.registrations,
        agent?.output_schema_reference,
      )
      const outputSchemaOperations: YamlSourceOperation[] = agent === undefined
        ? []
        : [{
            op: "set",
            path: ["nodes", selected.index, "output_schema"],
            value: agent.output_schema_reference,
          }]
      onOperations([
        ...addWorkflowCapabilityOperations(source, agentCapabilities),
        { op: "set", path: ["nodes", selected.index, "agent"], value: registrationId },
        ...outputSchemaOperations,
      ])
      return
    }

    const registration = library.registrations.find(
      (item) => item.id === registrationId,
    )
    const nextPolicies = reconcileWorkflowBuiltInPolicies(
      library.registrations,
      selectedRegistration,
      registration,
      policies,
    )
    const policyEntry = workflowBuiltInPolicyEntry(
      library.registrations,
      registration,
    )
    const policyRegistration = policyEntry === undefined
      ? undefined
      : library.registrations.find((item) => item.id === policyEntry.uses)
    const operations: YamlSourceOperation[] = [
      ...addWorkflowCapabilityOperations(source, [
        registration?.owner.capability_id,
        policyRegistration?.owner.capability_id,
      ]),
      { op: "set", path: ["nodes", selected.index, "uses"], value: registrationId },
    ]
    if (nextPolicies.length === 0 && policies.length > 0) {
      operations.push({
        op: "delete",
        path: ["nodes", selected.index, "policies"],
      })
    } else if (
      nextPolicies.length !== policies.length ||
      nextPolicies.some((policy, index) => policy !== policies[index])
    ) {
      operations.push({
        op: "set",
        path: ["nodes", selected.index, "policies"],
        value: nextPolicies,
      })
    }
    onOperations(operations)
  }

  const toggleDependency = (nodeId: string, checked: boolean) => {
    const next = checked
      ? [...dependencies, nodeId]
      : dependencies.filter((dependency) => dependency !== nodeId)
    onOperations([
      next.length === 0
        ? { op: "delete", path: ["nodes", selected.index, "after"] }
        : { op: "set", path: ["nodes", selected.index, "after"], value: next },
    ])
  }

  return (
    <div className="mt-4 space-y-5 text-sm">
      <WorkflowNodeIdentityEditor
        nodes={nodes}
        selected={selected}
        canMutate={canMutate}
        pending={pending}
        onOperations={onOperations}
      />

      <Separator />
      <Field>
        <FieldLabel htmlFor="workflow-node-registration">
          {selected.type === "agent" ? "Agent" : "Registration / capability"}
        </FieldLabel>
        <NativeSelect
          id="workflow-node-registration"
          className="w-full"
          value={selected.registrationId}
          disabled={!canMutate || pending}
          onChange={(event) => changeRegistration(event.target.value)}
        >
          {(selected.type === "agent" ? agents : registrations).map((option) => (
            <NativeSelectOption key={option.id} value={option.id}>
              {option.id}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {selectedRegistration !== undefined && (
          <FieldDescription>
            {selectedRegistration.presentation.summary ?? selectedRegistration.presentation.title}
          </FieldDescription>
        )}
        {selectedRegistration?.registration_kind === "built_in" &&
          selectedRegistration.side_effect_policy !== undefined && (
            <Badge variant="outline" className="border-destructive/50 text-foreground">
              Exige policy {selectedRegistration.side_effect_policy}
            </Badge>
          )}
      </Field>

      <WorkflowNodeContractSummary node={selected} library={library} agents={agents} />

      {selected.type === "pattern" && (
        <Field>
          <FieldLabel htmlFor="workflow-pattern-worker">Worker agent</FieldLabel>
          <NativeSelect
            id="workflow-pattern-worker"
            className="w-full"
            value={typeof workflowNodeField(selected, "worker") === "string"
              ? String(workflowNodeField(selected, "worker"))
              : ""}
            disabled={!canMutate || pending}
            onChange={(event) => {
              const workerId = event.target.value
              if (workerId === "") {
                onOperations([{
                  op: "delete",
                  path: ["nodes", selected.index, "worker"],
                }])
                return
              }
              const worker = agents.find((agent) => agent.id === workerId)
              onOperations([
                ...addWorkflowCapabilityOperations(
                  source,
                  workflowAgentCapabilityIds(
                    library.capabilities,
                    library.registrations,
                    worker?.output_schema_reference,
                  ),
                ),
                {
                  op: "set",
                  path: ["nodes", selected.index, "worker"],
                  value: workerId,
                },
              ])
            }}
          >
            <NativeSelectOption value="">Não declarado</NativeSelectOption>
            {agents.map((agent) => (
              <NativeSelectOption key={agent.id} value={agent.id}>{agent.id}</NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}

      <Separator />
      <Field>
        <FieldLabel>After / dependências</FieldLabel>
        <FieldDescription>
          Arestas semânticas da DAG. Dependências que criariam ciclo são bloqueadas antes da escrita.
        </FieldDescription>
        <div className="space-y-2 rounded-lg border p-3">
          {nodes.filter((node) => node.id !== selected.id).map((node) => {
            const selectedDependency = dependencies.includes(node.id)
            const wouldCycle =
              !selectedDependency &&
              workflowDependencyWouldCycle(nodes, selected.id, node.id)
            return (
              <label key={node.id} className="flex items-center gap-2">
                <Checkbox
                  checked={selectedDependency}
                  disabled={!canMutate || pending || wouldCycle}
                  onCheckedChange={(checked) => toggleDependency(node.id, checked === true)}
                />
                <span className="font-mono text-xs">
                  {node.id}
                  {wouldCycle && (
                    <span className="font-sans text-foreground"> (criaria ciclo)</span>
                  )}
                </span>
              </label>
            )
          })}
          {nodes.length === 1 && (
            <span className="text-xs text-muted-foreground">Nenhum outro node.</span>
          )}
        </div>
      </Field>

      <Separator />
      <WorkflowExpressionBuilder
        node={selected}
        nodes={nodes}
        canMutate={canMutate}
        pending={pending}
        onOperations={onOperations}
        fixtures={expressionFixtures}
        onSaveFixture={onSaveExpressionFixture}
        onRemoveFixture={onRemoveExpressionFixture}
      />
      <WorkflowJsonField
        label="Input JSON avançado"
        description="Visão bruta sincronizada para objetos que não cabem no builder."
        path={["nodes", selected.index, "input"]}
        value={workflowNodeField(selected, "input")}
        canMutate={canMutate}
        pending={pending}
        onOperations={onOperations}
      />

      {selected.type === "agent" && (
        <>
          <WorkflowJsonField
            label="Retry"
            description="Política de retry pertencente ao node agent."
            path={["nodes", selected.index, "retry"]}
            value={workflowNodeField(selected, "retry")}
            canMutate={canMutate}
            pending={pending}
            onOperations={onOperations}
          />
          <WorkflowJsonField
            label="Runtime requirements"
            path={["nodes", selected.index, "runtime_requirements"]}
            value={workflowNodeField(selected, "runtime_requirements")}
            canMutate={canMutate}
            pending={pending}
            onOperations={onOperations}
          />
        </>
      )}
      {selected.type === "pattern" && (
        <>
          <WorkflowJsonField
            label="Repair"
            description="Repair permanece no pattern; nunca é gravado no agent reutilizável."
            path={["nodes", selected.index, "repair"]}
            value={workflowNodeField(selected, "repair")}
            canMutate={canMutate}
            pending={pending}
            onOperations={onOperations}
          />
          <WorkflowJsonField
            label="Capabilities locais"
            path={["nodes", selected.index, "capabilities"]}
            value={workflowNodeField(selected, "capabilities")}
            canMutate={canMutate}
            pending={pending}
            onOperations={onOperations}
          />
        </>
      )}
      {selected.type === "human_gate" && (
        <WorkflowJsonField
          label="Decision"
          description="Configuração semântica do interrupt; approval remoto não é executado por esta UI."
          path={["nodes", selected.index, "decision"]}
          value={workflowNodeField(selected, "decision")}
          canMutate={canMutate}
          pending={pending}
          onOperations={onOperations}
        />
      )}

      <WorkflowNodeResourcesEditor
        source={source}
        selected={selected}
        library={library}
        canMutate={canMutate}
        pending={pending}
        onOperations={onOperations}
      />

      <WorkflowNodeDeleteControl
        nodes={nodes}
        selected={selected}
        canMutate={canMutate}
        pending={pending}
        onOperations={onOperations}
      />
    </div>
  )
}
