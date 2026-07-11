import { useMemo, useState, type FormEvent } from "react"
import { PlusIcon } from "lucide-react"

import type {
  AgentCatalogItem,
  CapabilityCatalog,
  CapabilityRegistration,
  JsonValue,
  YamlSourceOperation,
} from "@/api/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  workflowAgentCapabilityIds,
  workflowBuiltInPolicyEntry,
  type WorkflowCatalogNodeKind,
  workflowNodeRegistrations,
} from "@/features/workflows/workflow-node-catalog"
import {
  addWorkflowCapabilityOperations,
  type WorkflowSourceNode,
} from "@/features/workflows/workflow-source-model"

const NODE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

function selectionCapabilities(
  library: CapabilityCatalog,
  kind: WorkflowCatalogNodeKind,
  registrationId: string,
  agent: AgentCatalogItem | undefined,
): string[] {
  const registration = library.registrations.find((item) => item.id === registrationId)
  const policyCapability = registration?.registration_kind === "built_in" &&
    registration.side_effect_policy !== undefined
    ? library.registrations.find((item) => item.id === registration.side_effect_policy)?.owner.capability_id
    : undefined
  return [...new Set([
    ...(kind === "agent"
      ? workflowAgentCapabilityIds(
          library.capabilities,
          library.registrations,
          agent?.output_schema_reference,
        )
      : [registration?.owner.capability_id]),
    policyCapability,
  ].filter((value): value is string => value !== undefined))]
}

function newNode(
  kind: WorkflowCatalogNodeKind,
  id: string,
  registrationId: string,
  registration: CapabilityRegistration | undefined,
  agent: AgentCatalogItem | undefined,
  registrations: readonly CapabilityRegistration[],
): Record<string, JsonValue> {
  if (kind === "agent") {
    return {
      id,
      type: "agent",
      agent: registrationId,
      output_schema: agent?.output_schema_reference ?? "output.schema.json",
    }
  }
  const node: Record<string, JsonValue> = { id, type: kind, uses: registrationId }
  const policy = kind === "built_in"
    ? workflowBuiltInPolicyEntry(registrations, registration)
    : undefined
  if (policy !== undefined) node.policies = [policy]
  return node
}

export function WorkflowNodeAdd({
  source,
  nodes,
  library,
  agents,
  canMutate,
  pending,
  onOperations,
}: {
  source: JsonValue
  nodes: readonly WorkflowSourceNode[]
  library: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
  canMutate: boolean
  pending: boolean
  onOperations: (operations: readonly YamlSourceOperation[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [id, setId] = useState("")
  const [kind, setKind] = useState<WorkflowCatalogNodeKind>("built_in")
  const options = useMemo(
    () => kind === "agent" ? agents : workflowNodeRegistrations(library.registrations, kind),
    [agents, kind, library],
  )
  const [registrationId, setRegistrationId] = useState("")
  const selectedId = options.some((option) => option.id === registrationId)
    ? registrationId
    : options[0]?.id ?? ""
  const duplicate = nodes.some((node) => node.id === id)
  const valid = NODE_ID.test(id) && id.length <= 128 && !duplicate && selectedId.length > 0

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!valid) return
    const selectedRegistration = library.registrations.find(
      (registration) => registration.id === selectedId,
    )
    const selectedAgent = agents.find((agent) => agent.id === selectedId)
    const capabilities = selectionCapabilities(library, kind, selectedId, selectedAgent)
    if (capabilities.length === 0) return
    const operations: YamlSourceOperation[] = addWorkflowCapabilityOperations(source, capabilities)
    operations.push({
      op: "sequence_insert",
      path: ["nodes"],
      value: newNode(
        kind,
        id,
        selectedId,
        selectedRegistration,
        selectedAgent,
        library.registrations,
      ),
    })
    onOperations(operations)
    setOpen(false)
    setId("")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" disabled={!canMutate || pending} />}>
        <PlusIcon aria-hidden="true" /> Adicionar node
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Adicionar node</DialogTitle>
            <DialogDescription>
              Registrations vêm da Library carregada; o compiler do servidor decide se a combinação é válida.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field data-invalid={duplicate || (id.length > 0 && !NODE_ID.test(id))}>
              <FieldLabel htmlFor="new-workflow-node-id">ID</FieldLabel>
              <Input id="new-workflow-node-id" value={id} onChange={(event) => setId(event.target.value)} />
              <FieldDescription>Único dentro do workflow.</FieldDescription>
              {duplicate && <FieldError>Já existe um node com este ID.</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="new-workflow-node-kind">Tipo</FieldLabel>
              <NativeSelect
                id="new-workflow-node-kind"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as WorkflowCatalogNodeKind)
                  setRegistrationId("")
                }}
                className="w-full"
              >
                <NativeSelectOption value="built_in">Built-in</NativeSelectOption>
                <NativeSelectOption value="pattern">Pattern</NativeSelectOption>
                <NativeSelectOption value="agent">Agent</NativeSelectOption>
                <NativeSelectOption value="human_gate">Human gate</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="new-workflow-node-registration">
                {kind === "agent" ? "Agent" : "Registration"}
              </FieldLabel>
              <NativeSelect
                id="new-workflow-node-registration"
                value={selectedId}
                onChange={(event) => setRegistrationId(event.target.value)}
                className="w-full"
              >
                {options.map((option) => (
                  <NativeSelectOption key={option.id} value={option.id}>{option.id}</NativeSelectOption>
                ))}
              </NativeSelect>
              {selectedId.length > 0 && (
                <FieldDescription>
                  A mesma operação declara, se ausentes, todas as capabilities exigidas por registration, schema e policy: <code>{selectionCapabilities(library, kind, selectedId, agents.find((agent) => agent.id === selectedId)).join(", ") || "desconhecida"}</code>.
                </FieldDescription>
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button type="submit" disabled={!valid || pending}>Adicionar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
