import { useMemo } from "react"

import type {
  AgentCatalogItem,
  CapabilityCatalog,
  JsonValue,
  WorkflowSummary,
  YamlSourceOperation,
} from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Separator } from "@/components/ui/separator"
import { WorkflowExpressionBuilder } from "@/features/workflows/workflow-expression-builder"
import { workflowAvailableInputNodes, workflowSchemaFields } from "@/features/workflows/workflow-data-mapping"
import type { WorkflowExpressionFixtures } from "@/features/workflows/workflow-expression-fixtures"
import { WorkflowChildSelector } from "@/features/workflows/workflow-child-selector"
import { workflowCompositionIssue } from "@/features/workflows/workflow-composition-compatibility"
import { WorkflowNodeAdvancedFields, WorkflowNodeDependencies } from "@/features/workflows/workflow-node-advanced-sections"
import {
  reconcileWorkflowBuiltInPolicies,
  workflowAgentCapabilityIds,
  workflowBuiltInPolicyEntry,
  workflowNodeRegistrations,
} from "@/features/workflows/workflow-node-catalog"
import { WorkflowNodeContractSummary } from "@/features/workflows/workflow-node-contract-summary"
import { WorkflowNodeNoteEditor } from "@/features/workflows/workflow-node-note-editor"
import { WorkflowNodeDataPanel } from "@/features/workflows/workflow-node-data-panel"
import { WorkflowInspectorDiagnosticField } from "@/features/workflows/workflow-inspector-diagnostic-field"
import {
  workflowInspectorField,
  workflowInspectorFieldDiagnostics,
  type WorkflowNodeDiagnostic,
} from "@/features/workflows/workflow-node-diagnostics"
import { WorkflowNodeIdentityEditor } from "@/features/workflows/workflow-node-refactor-controls"
import {
  addWorkflowCapabilityOperations,
  ensureWorkflowRepositoryRequirementOperations,
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
  workflows = [],
  canMutate,
  pending,
  onOperations,
  expressionFixtures,
  activeExpressionFixtureName,
  onSaveExpressionFixture,
  onRemoveExpressionFixture,
  onSelectExpressionFixture,
  note,
  onSaveNote,
  diagnostics = [],
  focusedFieldPath,
  section = "all",
}: {
  source: JsonValue
  nodes: readonly WorkflowSourceNode[]
  selected: WorkflowSourceNode
  library: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
  workflows?: readonly WorkflowSummary[]
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
  expressionFixtures: WorkflowExpressionFixtures
  activeExpressionFixtureName?: string
  onSaveExpressionFixture: (name: string, value: JsonValue) => void
  onRemoveExpressionFixture: (name: string) => void
  onSelectExpressionFixture?: (name: string) => void
  note: string
  onSaveNote: (note: string) => void
  diagnostics?: readonly WorkflowNodeDiagnostic[]
  focusedFieldPath?: readonly (string | number)[]
  section?: "all" | "summary" | "inputs" | "advanced"
}) {
  const focusedField = workflowInspectorField(focusedFieldPath)
  const registrations = useMemo(
    () => workflowNodeRegistrations(library.registrations, selected.type),
    [library, selected],
  )
  const selectedRegistration = library.registrations.find(
    (registration) => registration.id === selected.registrationId,
  )
  const selectedWorkflow = selected.type === "workflow"
    ? workflows.find((workflow) => workflow.id === selected.registrationId)
    : undefined
  const selectedWorkflowIssue = selectedWorkflow === undefined
    ? undefined
    : workflowCompositionIssue(source, selectedWorkflow)
  const selectableWorkflows = workflows.filter((workflow) =>
    workflow.id === selected.registrationId ||
    workflowCompositionIssue(source, workflow) === undefined,
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
    if (node.type === "workflow") {
      const workflow = workflows.find((candidate) => candidate.id === node.registrationId)
      return [node.id, workflowSchemaFields(workflow?.output_schema_content)] as const
    }
    const registration = library.registrations.find(
      (candidate) => candidate.id === node.registrationId,
    )
    const outputSchema = registration !== undefined && "output_schema" in registration
      ? registration.output_schema
      : undefined
    return [node.id, workflowSchemaFields(outputSchema)] as const
  })), [agents, library.registrations, nodes, workflows])
  const availableSources = useMemo(
    () => workflowAvailableInputNodes(selected, nodes),
    [nodes, selected],
  )
  const outputFields = availableSourceFields.get(selected.id) ?? []

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
    if (selected.type === "workflow") {
      const workflow = workflows.find((candidate) => candidate.id === registrationId)
      if (
        workflow === undefined ||
        workflowCompositionIssue(source, workflow) !== undefined
      ) return
      onOperations([
        ...ensureWorkflowRepositoryRequirementOperations(source, workflow.requires_repository),
        { op: "set", path: ["nodes", selected.index, "workflow"], value: registrationId },
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
      ...ensureWorkflowRepositoryRequirementOperations(
        source,
        registration?.registration_kind === "built_in" &&
          registration.requires_repository,
      ),
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

  const technicalRegistrationField = (
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
        selectedRegistration.requires_repository && (
          <Badge variant="outline">Exige repositório local</Badge>
        )}
      {selectedRegistration?.registration_kind === "built_in" &&
        selectedRegistration.side_effect_policy !== undefined && (
          <Badge variant="outline" className="border-destructive/50 text-foreground">
            Exige policy {selectedRegistration.side_effect_policy}
          </Badge>
        )}
    </Field>
  )

  const registrationField = selected.type === "workflow"
    ? (
        <WorkflowChildSelector
          workflowId={selected.registrationId}
          workflows={selectableWorkflows}
          disabled={!canMutate || pending}
          issue={selectedWorkflowIssue}
          onSelect={changeRegistration}
        />
      )
    : technicalRegistrationField

  return (
    <div className="mt-4 space-y-5 text-sm">
      {(section === "all" || section === "summary") && <>
      <WorkflowInspectorDiagnosticField field="registration" diagnostics={diagnostics} focused={focusedField === "registration"}>
        {selected.type === "agent" || selected.type === "workflow" ? registrationField : (
          <details className="rounded-lg border" open={workflowInspectorFieldDiagnostics(diagnostics, "registration").length > 0 || undefined}>
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Trocar ação técnica</summary>
            <div className="border-t p-3">{registrationField}</div>
          </details>
        )}
      </WorkflowInspectorDiagnosticField>

      <WorkflowNodeContractSummary node={selected} library={library} agents={agents} workflows={workflows} />

      <WorkflowNodeDataPanel
        node={selected}
        sources={availableSources}
        sourceFields={availableSourceFields}
        outputFields={outputFields}
      />

      <WorkflowNodeNoteEditor
        nodeId={selected.id}
        note={note}
        disabled={!canMutate || pending}
        onSave={onSaveNote}
      />
      </>}

      {(section === "all" || section === "advanced") && <>
      <WorkflowInspectorDiagnosticField field="identity" diagnostics={diagnostics} focused={focusedField === "identity"}>
        <details className="rounded-lg border" open={workflowInspectorFieldDiagnostics(diagnostics, "identity").length > 0 || undefined}>
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">ID e refactor técnico</summary>
          <div className="border-t p-3">
            <WorkflowNodeIdentityEditor
              nodes={nodes}
              selected={selected}
              canMutate={canMutate}
              pending={pending}
              onOperations={onOperations}
            />
          </div>
        </details>
      </WorkflowInspectorDiagnosticField>

      {selected.type === "pattern" && (
        <WorkflowInspectorDiagnosticField field="worker" diagnostics={diagnostics} focused={focusedField === "worker"}>
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
        </WorkflowInspectorDiagnosticField>
      )}
      </>}

      {(section === "all" || section === "inputs") && <>
      <WorkflowInspectorDiagnosticField field="dependencies" diagnostics={diagnostics} focused={focusedField === "dependencies"}>
      <WorkflowNodeDependencies nodes={nodes} selected={selected} dependencies={dependencies} canMutate={canMutate} pending={pending} onToggle={toggleDependency} />
      </WorkflowInspectorDiagnosticField>

      <Separator />
      <WorkflowInspectorDiagnosticField field="input" diagnostics={diagnostics} focused={focusedField === "input"}>
      <WorkflowExpressionBuilder
        node={selected}
        nodes={nodes}
        canMutate={canMutate}
        pending={pending}
        onOperations={onOperations}
        fixtures={expressionFixtures}
        activeFixtureName={activeExpressionFixtureName}
        onSaveFixture={onSaveExpressionFixture}
        onRemoveFixture={onRemoveExpressionFixture}
        onSelectFixture={onSelectExpressionFixture}
        suggestedFields={workflowSchemaFields(
          selected.type === "workflow"
            ? selectedWorkflow?.input_schema_content
            : selectedRegistration !== undefined && "input_schema" in selectedRegistration
              ? selectedRegistration.input_schema
              : undefined,
        )}
        availableSourceFields={availableSourceFields}
      />
      </WorkflowInspectorDiagnosticField>
      </>}
      {(section === "all" || section === "advanced") && (
      <WorkflowInspectorDiagnosticField field="advanced" diagnostics={diagnostics} focused={focusedField === "advanced"}>
      <WorkflowNodeAdvancedFields source={source} nodes={nodes} selected={selected} library={library} canMutate={canMutate} pending={pending} onOperations={onOperations} />
      </WorkflowInspectorDiagnosticField>
      )}
    </div>
  )
}
