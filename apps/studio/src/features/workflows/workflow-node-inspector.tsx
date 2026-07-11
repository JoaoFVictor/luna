import { useMemo } from "react"

import type {
  AgentCatalogItem,
  CapabilityCatalog,
  JsonValue,
  YamlSourceOperation,
} from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Separator } from "@/components/ui/separator"
import { WorkflowExpressionBuilder } from "@/features/workflows/workflow-expression-builder"
import { workflowSchemaFields } from "@/features/workflows/workflow-data-mapping"
import type { WorkflowExpressionFixtures } from "@/features/workflows/workflow-expression-fixtures"
import { WorkflowNodeAdvancedFields, WorkflowNodeDependencies } from "@/features/workflows/workflow-node-advanced-sections"
import {
  reconcileWorkflowBuiltInPolicies,
  workflowAgentCapabilityIds,
  workflowBuiltInPolicyEntry,
  workflowNodeRegistrations,
} from "@/features/workflows/workflow-node-catalog"
import { WorkflowNodeContractSummary } from "@/features/workflows/workflow-node-contract-summary"
import { WorkflowNodeNoteEditor } from "@/features/workflows/workflow-node-note-editor"
import { WorkflowNodeIdentityEditor } from "@/features/workflows/workflow-node-refactor-controls"
import {
  addWorkflowCapabilityOperations,
  workflowNodeField,
  type WorkflowSourceNode,
} from "@/features/workflows/workflow-source-model"
import { presentationTitle } from "@/lib/presentation"

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
  note,
  onSaveNote,
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
  note: string
  onSaveNote: (note: string) => void
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
  const availableSourceFields = useMemo(() => new Map(nodes.map((node) => {
    if (node.type === "agent") {
      const agent = agents.find((candidate) => candidate.id === node.registrationId)
      return [node.id, workflowSchemaFields(agent?.output_schema)] as const
    }
    const registration = library.registrations.find(
      (candidate) => candidate.id === node.registrationId,
    )
    const outputSchema = registration !== undefined && "output_schema" in registration
      ? registration.output_schema
      : undefined
    return [node.id, workflowSchemaFields(outputSchema)] as const
  })), [agents, library.registrations, nodes])

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
              {"presentation" in option ? presentationTitle(option.id, option.presentation.title) : presentationTitle(option.id, option.id)}
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

      <WorkflowNodeNoteEditor
        nodeId={selected.id}
        note={note}
        disabled={!canMutate || pending}
        onSave={onSaveNote}
      />

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

      <WorkflowNodeDependencies nodes={nodes} selected={selected} dependencies={dependencies} canMutate={canMutate} pending={pending} onToggle={toggleDependency} />

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
        suggestedFields={workflowSchemaFields(
          selectedRegistration !== undefined && "input_schema" in selectedRegistration
            ? selectedRegistration.input_schema
            : undefined,
        )}
        availableSourceFields={availableSourceFields}
      />
      <WorkflowNodeAdvancedFields source={source} nodes={nodes} selected={selected} library={library} canMutate={canMutate} pending={pending} onOperations={onOperations} />
    </div>
  )
}
