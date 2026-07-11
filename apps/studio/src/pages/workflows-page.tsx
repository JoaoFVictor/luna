import { useEffect, useMemo, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircleIcon, AlertTriangleIcon, FilePlus2Icon, NetworkIcon, PencilLineIcon, SearchIcon } from "lucide-react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import { agentsQuery, draftsQuery, draftTemplatesQuery, studioKeys, workflowsQuery } from "@/api/queries"
import type { WorkflowDraftCreateSource } from "@/api/types"
import { useStudioSession } from "@/app/studio-context"
import { PageHeader } from "@/components/page-header"
import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
import { DraftStatusBadge, ModeBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { shortDigest } from "@/lib/format"
import { WorkflowTemplatePreview } from "@/features/workflows/workflow-template-preview"

const RESOURCE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

function nodeTotal(counts: {
  built_in: number
  agent: number
  pattern: number
  human_gate: number
}) {
  return counts.built_in + counts.agent + counts.pattern + counts.human_gate
}

export function WorkflowsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useStudioSession()
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState("")
  const [newId, setNewId] = useState("")
  const [templateId, setTemplateId] = useState("blank-workflow")
  const [agentIds, setAgentIds] = useState<Readonly<Record<string, string>>>({})
  const workflows = useQuery(workflowsQuery)
  const drafts = useQuery(draftsQuery)
  const templates = useQuery(draftTemplatesQuery)
  const agents = useQuery(agentsQuery)
  const newOpen = session.canMutate && params.get("new") === "1"

  const setNewOpen = (open: boolean) => {
    const next = new URLSearchParams(params)
    if (open && !session.canMutate) {
      next.delete("new")
      setParams(next, { replace: true })
      return
    }
    if (open) next.set("new", "1")
    else next.delete("new")
    setParams(next, { replace: true })
  }

  useEffect(() => {
    if (!newOpen) {
      setNewId("")
      setTemplateId("blank-workflow")
      setAgentIds({})
    }
  }, [newOpen])

  const openDraft = useMutation({
    mutationFn: ({ id, source }: { id: string; source: WorkflowDraftCreateSource }) => {
      if (!session.canMutate) {
        throw new Error("A sessão atual é somente leitura")
      }
      return studioApi.createDraft({
        resource: { kind: "workflow", id },
        source,
      })
    },
    onSuccess: (draft) => {
      void queryClient.invalidateQueries({ queryKey: studioKeys.drafts })
      setNewOpen(false)
      void navigate(`/drafts/${encodeURIComponent(draft.draft_id)}`)
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Falha ao criar draft"),
  })

  const selectedTemplate = templates.data?.templates.find(
    (template) => template.id === templateId,
  )
  const agentParameters = selectedTemplate?.parameters.filter(
    (parameter) => parameter.kind === "agent",
  ) ?? []
  const selectedAgents = Object.fromEntries(
    agentParameters.map((parameter) => [
      parameter.id,
      agents.data?.agents.find((agent) => agent.id === agentIds[parameter.id]),
    ]),
  )
  const requiredAgentsSelected = agentParameters.every(
    (parameter) => !parameter.required || selectedAgents[parameter.id] !== undefined,
  )
  const catalogDiagnostics = workflows.data?.diagnostics ?? []

  const draftByWorkflow = useMemo(() => {
    const map = new Map<string, NonNullable<typeof drafts.data>["items"][number]>()
    for (const draft of drafts.data?.items ?? []) {
      if (draft.primary_resource.kind === "workflow" && !map.has(draft.primary_resource.id)) {
        map.set(draft.primary_resource.id, draft)
      }
    }
    return map
  }, [drafts.data])

  const filtered = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase()
    return (workflows.data?.workflows ?? []).filter(
      (workflow) =>
        normalized.length === 0 ||
        workflow.id.toLocaleLowerCase().includes(normalized) ||
        workflow.capabilities.some((capability) => capability.toLocaleLowerCase().includes(normalized)),
    )
  }, [search, workflows.data])

  const submitNew = (event: FormEvent) => {
    event.preventDefault()
    if (
      !session.canMutate ||
      !RESOURCE_ID.test(newId) ||
      newId.length > 128 ||
      selectedTemplate === undefined ||
      !requiredAgentsSelected
    ) return
    const parameters = Object.fromEntries(
      agentParameters.flatMap((parameter) => {
        const selected = selectedAgents[parameter.id]
        return selected === undefined
          ? []
          : [[parameter.id, {
              id: selected.id,
              output_schema: selected.output_schema_reference,
              mode: selected.mode,
            }]]
      }),
    )
    openDraft.mutate({
      id: newId,
      source: {
        mode: "template",
        template_id: selectedTemplate.id,
        template_version: selectedTemplate.version,
        ...(Object.keys(parameters).length === 0 ? {} : { parameters }),
      },
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Catálogo"
        title="Workflows"
        description="Definições carregadas pelo loader canônico. Dependências de execução e referências de dados permanecem conceitos separados."
        actions={
          <Button onClick={() => setNewOpen(true)} disabled={!session.canMutate}>
            <FilePlus2Icon aria-hidden="true" />
            Novo workflow
          </Button>
        }
      />

      <div className="relative max-w-md">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar por id ou capability"
          aria-label="Buscar workflows"
          className="pl-8"
        />
      </div>

      {drafts.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Drafts indisponíveis</AlertTitle>
          <AlertDescription>
            O catálogo de workflows continua visível, mas o Studio não pode afirmar se já existe um draft para cada item. Recarregue antes de criar outro change set.
          </AlertDescription>
        </Alert>
      )}

      {workflows.data?.status === "partial" && (
        <Alert variant="destructive">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>Catálogo parcial: {catalogDiagnostics.length} workflow(s) inválido(s)</AlertTitle>
          <AlertDescription>
            <p>Somente workflows aceitos pelo loader canônico aparecem na tabela. Corrija os itens abaixo antes de tratar a lista como completa.</p>
            <ul className="mt-2 space-y-1 font-mono text-xs">
              {catalogDiagnostics.slice(0, 20).map((diagnostic, index) => (
                <li key={`${diagnostic.resource_id}:${diagnostic.code}:${index}`}>
                  {diagnostic.resource_id}: {diagnostic.code} — {diagnostic.message}
                </li>
              ))}
            </ul>
            {catalogDiagnostics.length > 20 && (
              <p className="mt-2 text-xs">Mais {catalogDiagnostics.length - 20} diagnóstico(s) não exibido(s).</p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {workflows.isPending ? (
        <PageLoading label="Carregando workflows" />
      ) : workflows.isError ? (
        <PageError error={workflows.error} retry={() => void workflows.refetch()} />
      ) : filtered.length === 0 ? (
        <PageEmpty
          title={search.length > 0 ? "Nenhum workflow corresponde à busca" : "Nenhum workflow válido carregado"}
          description={search.length > 0 ? "Ajuste o filtro para procurar outro id ou capability." : workflows.data?.status === "partial" ? "Todos os candidatos podem ter sido rejeitados; revise os diagnósticos do catálogo acima." : "O catálogo seguro não retornou um workflow. Crie um draft blank e valide-o antes do apply."}
          action={session.canMutate ? <Button onClick={() => setNewOpen(true)}>Novo workflow</Button> : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Nodes</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead>Revision</TableHead>
                <TableHead className="text-right">Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((workflow) => {
                const draft = draftByWorkflow.get(workflow.id)
                return (
                  <TableRow key={workflow.id}>
                    <TableCell>
                      <button
                        type="button"
                        className="flex items-center gap-2 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => void navigate(`/workflows/${encodeURIComponent(workflow.id)}`)}
                      >
                        <NetworkIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                        {workflow.id}
                      </button>
                      {draft !== undefined && <div className="mt-1"><DraftStatusBadge status={draft.status} /></div>}
                    </TableCell>
                    <TableCell><ModeBadge mode={workflow.mode} /></TableCell>
                    <TableCell>{nodeTotal(workflow.node_counts)}</TableCell>
                    <TableCell>
                      <div className="flex max-w-64 flex-wrap gap-1">
                        {workflow.capabilities.slice(0, 3).map((capability) => (
                          <Badge key={capability} variant="outline">{capability}</Badge>
                        ))}
                        {workflow.capabilities.length > 3 && <Badge variant="secondary">+{workflow.capabilities.length - 3}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{shortDigest(workflow.revision)}</TableCell>
                    <TableCell className="text-right">
                      {draft !== undefined ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void navigate(`/drafts/${encodeURIComponent(draft.draft_id)}`)}
                        >
                          <PencilLineIcon aria-hidden="true" /> Abrir draft
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!session.canMutate || openDraft.isPending || drafts.isError}
                          onClick={() => openDraft.mutate({
                            id: workflow.id,
                            source: { mode: "existing" },
                          })}
                        >
                          <PencilLineIcon aria-hidden="true" /> Editar
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <form onSubmit={submitNew} className="contents">
            <DialogHeader>
              <DialogTitle>Novo workflow</DialogTitle>
              <DialogDescription>
                Cria um draft isolado com o conjunto mínimo de arquivos. Nada será escrito no projeto até o apply confirmado.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="new-workflow-id">ID do workflow</FieldLabel>
              <Input
                id="new-workflow-id"
                autoFocus
                value={newId}
                onChange={(event) => setNewId(event.target.value)}
                placeholder="meu-workflow"
                aria-invalid={newId.length > 0 && (!RESOURCE_ID.test(newId) || newId.length > 128)}
              />
              <FieldDescription>Use letras, números, ponto, hífen ou underscore; comece e termine com letra ou número.</FieldDescription>
              {newId.length > 0 && (!RESOURCE_ID.test(newId) || newId.length > 128) && (
                <FieldError>O ID não atende ao contrato aceito pelo servidor.</FieldError>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="new-workflow-template">Template</FieldLabel>
              <NativeSelect
                id="new-workflow-template"
                value={templateId}
                onChange={(event) => {
                  setTemplateId(event.target.value)
                  setAgentIds({})
                }}
                disabled={templates.isPending || templates.isError}
                className="w-full"
              >
                {(templates.data?.templates ?? [])
                  .filter((template) => template.resource_kind === "workflow")
                  .map((template) => (
                    <NativeSelectOption key={`${template.id}@${template.version}`} value={template.id}>
                      {template.title} · v{template.version}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
              <FieldDescription>
                {selectedTemplate?.description ??
                  (templates.isError ? "O catálogo de templates está indisponível." : "Carregando templates versionados…")}
              </FieldDescription>
            </Field>
            {agentParameters.map((parameter) => (
              <Field key={parameter.id}>
                <FieldLabel htmlFor={`new-workflow-agent-${parameter.id}`}>{parameter.label}</FieldLabel>
                <NativeSelect
                  id={`new-workflow-agent-${parameter.id}`}
                  value={agentIds[parameter.id] ?? ""}
                  onChange={(event) => setAgentIds((current) => ({
                    ...current,
                    [parameter.id]: event.target.value,
                  }))}
                  disabled={agents.isPending || agents.isError || agents.data?.agents.length === 0}
                  className="w-full"
                >
                  <NativeSelectOption value="">{parameter.required ? "Selecione um agent" : "Nenhum"}</NativeSelectOption>
                  {(agents.data?.agents ?? [])
                    .filter((agent) => parameter.allowed_modes === undefined || parameter.allowed_modes.includes(agent.mode))
                    .map((agent) => (
                    <NativeSelectOption key={agent.id} value={agent.id}>
                      {agent.id} · {agent.mode}
                    </NativeSelectOption>
                    ))}
                </NativeSelect>
                <FieldDescription>
                  A referência entra no YAML e a definição do agent entra na closure imutável do draft.
                  {parameter.allowed_modes !== undefined && ` Modes aceitos: ${parameter.allowed_modes.join(", ")}.`}
                </FieldDescription>
              </Field>
            ))}
            {selectedTemplate !== undefined && (
              <WorkflowTemplatePreview
                template={selectedTemplate}
                workflowId={newId}
                agents={selectedAgents}
              />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNewOpen(false)}>Cancelar</Button>
              <Button
                type="submit"
                disabled={
                  !session.canMutate ||
                  openDraft.isPending ||
                  templates.isPending ||
                  templates.isError ||
                  selectedTemplate === undefined ||
                  !RESOURCE_ID.test(newId) ||
                  newId.length > 128 ||
                  !requiredAgentsSelected
                }
              >
                {openDraft.isPending ? "Criando…" : "Criar draft"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
