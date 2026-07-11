import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import { agentsQuery, draftTemplatesQuery, studioKeys } from "@/api/queries"
import { useStudioSession } from "@/app/studio-context"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { humanizeWorkflowIdentifier } from "./workflow-node-catalog"
import { WorkflowTemplatePreview } from "./workflow-template-preview"

const RESOURCE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

export function NewWorkflowDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useStudioSession()
  const templates = useQuery(draftTemplatesQuery)
  const agents = useQuery(agentsQuery)
  const [newId, setNewId] = useState("")
  const [templateId, setTemplateId] = useState("blank-workflow")
  const [agentIds, setAgentIds] = useState<Readonly<Record<string, string>>>({})
  const selectedTemplate = templates.data?.templates.find((template) => template.id === templateId)
  const agentParameters = selectedTemplate?.parameters.filter((parameter) => parameter.kind === "agent") ?? []
  const selectedAgents = Object.fromEntries(agentParameters.map((parameter) => [
    parameter.id,
    agents.data?.agents.find((agent) => agent.id === agentIds[parameter.id]),
  ]))
  const requiredAgentsSelected = agentParameters.every(
    (parameter) => !parameter.required || selectedAgents[parameter.id] !== undefined,
  )

  const create = useMutation({
    mutationFn: () => {
      if (!session.canMutate || selectedTemplate === undefined) throw new Error("Não é possível criar este workflow")
      const parameters = Object.fromEntries(agentParameters.flatMap((parameter) => {
        const selected = selectedAgents[parameter.id]
        return selected === undefined ? [] : [[parameter.id, {
          id: selected.id,
          output_schema: selected.output_schema_reference,
          mode: selected.mode,
        }]]
      }))
      return studioApi.createDraft({
        resource: { kind: "workflow", id: newId },
        source: {
          mode: "template",
          template_id: selectedTemplate.id,
          template_version: selectedTemplate.version,
          ...(Object.keys(parameters).length === 0 ? {} : { parameters }),
        },
      })
    },
    onSuccess: (draft) => {
      void queryClient.invalidateQueries({ queryKey: studioKeys.drafts })
      onOpenChange(false)
      void navigate(`/drafts/${encodeURIComponent(draft.draft_id)}`)
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Falha ao criar draft"),
  })

  const validId = RESOURCE_ID.test(newId) && newId.length <= 128
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (validId && requiredAgentsSelected) create.mutate()
  }
  const changeOpen = (next: boolean) => {
    if (!next) {
      setNewId("")
      setTemplateId("blank-workflow")
      setAgentIds({})
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="contents">
          <DialogHeader><DialogTitle>O que você quer automatizar?</DialogTitle><DialogDescription>Comece vazio ou escolha uma estrutura pronta. Você poderá mudar todos os passos no canvas.</DialogDescription></DialogHeader>
          <Field>
            <FieldLabel>Começar com</FieldLabel>
            <div className="grid gap-2 sm:grid-cols-2">
              {(templates.data?.templates ?? []).filter((template) => template.resource_kind === "workflow").map((template) => (
                <button key={`${template.id}@${template.version}`} type="button" className={`rounded-lg border p-3 text-left transition-colors ${templateId === template.id ? "border-primary bg-primary/5 ring-2 ring-primary/10" : "hover:bg-muted/60"}`} onClick={() => { setTemplateId(template.id); setAgentIds({}) }}>
                  <span className="block text-sm font-medium">{template.title}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{template.description}</span>
                </button>
              ))}
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="new-workflow-id">Nome curto</FieldLabel>
            <Input id="new-workflow-id" autoFocus value={newId} onChange={(event) => setNewId(event.target.value)} placeholder="meu-workflow" aria-invalid={newId.length > 0 && !validId} />
            <FieldDescription>Exemplo: revisar-pull-request. Este nome também será usado como identificador técnico.</FieldDescription>
            {newId.length > 0 && !validId && <FieldError>Use letras, números, ponto, hífen ou sublinhado, com até 128 caracteres.</FieldError>}
          </Field>
          {agentParameters.map((parameter) => (
            <Field key={parameter.id}>
              <FieldLabel htmlFor={`new-workflow-agent-${parameter.id}`}>{parameter.label}</FieldLabel>
              <NativeSelect id={`new-workflow-agent-${parameter.id}`} value={agentIds[parameter.id] ?? ""} onChange={(event) => setAgentIds((current) => ({ ...current, [parameter.id]: event.target.value }))} disabled={agents.isPending || agents.isError || agents.data?.agents.length === 0} className="w-full">
                <NativeSelectOption value="">{parameter.required ? "Selecione um agent" : "Nenhum"}</NativeSelectOption>
                {(agents.data?.agents ?? []).filter((agent) => parameter.allowed_modes === undefined || parameter.allowed_modes.includes(agent.mode)).map((agent) => <NativeSelectOption key={agent.id} value={agent.id}>{humanizeWorkflowIdentifier(agent.id)} · {agent.description}</NativeSelectOption>)}
              </NativeSelect>
              <FieldDescription>Escolha quem executará esta etapa. A autoridade será revisada antes de aplicar.</FieldDescription>
            </Field>
          ))}
          {selectedTemplate !== undefined && <details className="rounded-lg border"><summary className="cursor-pointer px-3 py-2 text-sm font-medium">Detalhes técnicos do que será criado</summary><div className="border-t p-3"><WorkflowTemplatePreview template={selectedTemplate} workflowId={newId} agents={selectedAgents} /></div></details>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => changeOpen(false)}>Cancelar</Button><Button type="submit" disabled={!session.canMutate || create.isPending || templates.isPending || templates.isError || selectedTemplate === undefined || !validId || !requiredAgentsSelected}>{create.isPending ? "Criando…" : "Criar draft"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
