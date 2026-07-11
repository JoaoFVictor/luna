import { useState } from "react"

import type {
  CapabilityCatalog,
  CapabilityRegistration,
  JsonValue,
  YamlSourceOperation,
} from "@/api/types"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { WorkflowJsonField } from "@/features/workflows/workflow-json-field"
import { workflowPolicyConfig } from "@/features/workflows/workflow-node-catalog"
import {
  addWorkflowCapabilityOperations,
  workflowNodeField,
  type WorkflowSourceNode,
} from "@/features/workflows/workflow-source-model"

function jsonArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function suggestedGateId(registrationId: string, existing: readonly JsonValue[]): string {
  const base = registrationId.split(".").at(-1)?.replace(/[^A-Za-z0-9_-]/gu, "-") || "gate"
  const ids = new Set(existing.flatMap((value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.id === "string"
      ? [value.id]
      : [],
  ))
  let candidate = base
  let suffix = 2
  while (ids.has(candidate)) candidate = `${base}-${suffix++}`
  return candidate
}

function RegistrationQuickAdd({
  id,
  label,
  description,
  options,
  value,
  disabled,
  onChange,
  onAdd,
}: {
  id: string
  label: string
  description?: string
  options: readonly CapabilityRegistration[]
  value: string
  disabled: boolean
  onChange: (value: string) => void
  onAdd: (registration: CapabilityRegistration) => void
}) {
  const selectedId = value || options[0]?.id || ""
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {description !== undefined && <FieldDescription>{description}</FieldDescription>}
      <div className="flex gap-2">
        <NativeSelect
          id={id}
          className="min-w-0 flex-1"
          value={selectedId}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        >
          {options.map((item) => (
            <NativeSelectOption key={item.id} value={item.id}>{item.id}</NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || options.length === 0}
          onClick={() => {
            const registration = options.find((item) => item.id === selectedId)
            if (registration !== undefined) onAdd(registration)
          }}
        >
          Adicionar
        </Button>
      </div>
    </Field>
  )
}

function withRegistrationCapability(
  source: JsonValue,
  registration: CapabilityRegistration,
  operation: YamlSourceOperation,
): YamlSourceOperation[] {
  return [
    ...addWorkflowCapabilityOperations(source, [registration.owner.capability_id]),
    operation,
  ]
}

export function WorkflowNodeResourcesEditor({
  source,
  selected,
  library,
  canMutate,
  pending,
  onOperations,
}: {
  source: JsonValue
  selected: WorkflowSourceNode
  library: CapabilityCatalog
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
}) {
  const [policyId, setPolicyId] = useState("")
  const [publisherId, setPublisherId] = useState("")
  const [gateId, setGateId] = useState("")
  const policies = jsonArray(workflowNodeField(selected, "policies"))
  const artifacts = jsonArray(workflowNodeField(selected, "artifacts"))
  const gates = jsonArray(workflowNodeField(selected, "gates"))
  const policyOptions = library.registrations.filter(
    (item) => item.registration_kind === "policy",
  )
  const publisherOptions = library.registrations.filter(
    (item) => item.registration_kind === "artifact_publisher",
  )
  const gateOptions = library.registrations.filter(
    (item) => item.registration_kind === "gate",
  )
  const disabled = !canMutate || pending

  return (
    <>
      {selected.type !== "human_gate" && (
        <>
          <RegistrationQuickAdd
            id="workflow-node-policy-registration"
            label="Policies"
            description="Anexa a policy e declara sua capability na mesma alteração, sempre visível no Diff."
            options={policyOptions}
            value={policyId}
            disabled={disabled}
            onChange={setPolicyId}
            onAdd={(policy) => onOperations(withRegistrationCapability(
              source,
              policy,
              {
                op: "set",
                path: ["nodes", selected.index, "policies"],
                value: [
                  ...policies,
                  { uses: policy.id, config: workflowPolicyConfig(policy) },
                ],
              },
            ))}
          />
          <WorkflowJsonField
            label="Policy definitions"
            description="A lista é validada contra as registrations de policy da Library."
            path={["nodes", selected.index, "policies"]}
            value={workflowNodeField(selected, "policies")}
            canMutate={canMutate}
            pending={pending}
            onOperations={onOperations}
          />
        </>
      )}

      <RegistrationQuickAdd
        id="workflow-node-artifact-registration"
        label="Artifacts"
        description="Anexa o publisher ao node e declara sua capability na mesma alteração."
        options={publisherOptions}
        value={publisherId}
        disabled={disabled}
        onChange={setPublisherId}
        onAdd={(publisher) => onOperations(withRegistrationCapability(
          source,
          publisher,
          {
            op: "set",
            path: ["nodes", selected.index, "artifacts"],
            value: [
              ...artifacts,
              {
                path: `${selected.id}.json`,
                publisher: publisher.id,
                source: { expression: `$.steps.${selected.id}` },
                format: "json",
              },
            ],
          },
        ))}
      />
      <WorkflowJsonField
        label="Artifact definitions"
        description="Path, publisher, source, format e config do node."
        path={["nodes", selected.index, "artifacts"]}
        value={workflowNodeField(selected, "artifacts")}
        canMutate={canMutate}
        pending={pending}
        onOperations={onOperations}
      />

      {selected.type === "pattern" && (
        <>
          <RegistrationQuickAdd
            id="workflow-node-gate-registration"
            label="Gates deste pattern"
            description="Gates só são gravados dentro do pattern; a capability correspondente entra na mesma alteração."
            options={gateOptions}
            value={gateId}
            disabled={disabled}
            onChange={setGateId}
            onAdd={(gate) => onOperations(withRegistrationCapability(
              source,
              gate,
              {
                op: "set",
                path: ["nodes", selected.index, "gates"],
                value: [
                  ...gates,
                  { id: suggestedGateId(gate.id, gates), type: gate.id, input: {} },
                ],
              },
            ))}
          />
          <WorkflowJsonField
            label="Gate definitions"
            description="Input, block_when e feedback permanecem no pattern correspondente."
            path={["nodes", selected.index, "gates"]}
            value={workflowNodeField(selected, "gates")}
            canMutate={canMutate}
            pending={pending}
            onOperations={onOperations}
          />
        </>
      )}
    </>
  )
}
