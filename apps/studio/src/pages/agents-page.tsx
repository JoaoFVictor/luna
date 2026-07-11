import { useMemo, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangleIcon, BotIcon, FilePlus2Icon, HistoryIcon, PencilLineIcon, SearchIcon } from "lucide-react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import { agentsQuery, configurationModelsQuery, draftsQuery, studioKeys } from "@/api/queries"
import type { AgentDraftCreateSource } from "@/api/types"
import { useStudioSession } from "@/app/studio-context"
import { PageHeader } from "@/components/page-header"
import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
import { ModeBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { shortDigest } from "@/lib/format"

const RESOURCE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

export function AgentsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useStudioSession()
  const agents = useQuery(agentsQuery)
  const drafts = useQuery(draftsQuery)
  const models = useQuery(configurationModelsQuery)
  const [search, setSearch] = useState("")
  const [newId, setNewId] = useState("")
  const [newModelProfile, setNewModelProfile] = useState("")
  const [params, setParams] = useSearchParams()
  const newOpen = session.canMutate && params.get("new") === "1"
  const selectedId = params.get("selected")
  const selected = agents.data?.agents.find((agent) => agent.id === selectedId)
  const draftByAgent = useMemo(() => {
    const index = new Map<string, NonNullable<typeof drafts.data>["items"][number]>()
    for (const draft of drafts.data?.items ?? []) {
      if (draft.primary_resource.kind === "agent" && !index.has(draft.primary_resource.id)) {
        index.set(draft.primary_resource.id, draft)
      }
    }
    return index
  }, [drafts.data])

  const openDraft = useMutation({
    mutationFn: ({ id, source }: { id: string; source: AgentDraftCreateSource }) => {
      if (!session.canMutate) {
        throw new Error("A sessão atual é somente leitura")
      }
      return studioApi.createDraft({
        resource: { kind: "agent", id },
        source,
      })
    },
    onSuccess: (draft) => {
      void queryClient.invalidateQueries({ queryKey: studioKeys.drafts })
      setNewOpen(false)
      setNewId("")
      setNewModelProfile("")
      void navigate(`/agent-drafts/${encodeURIComponent(draft.draft_id)}`)
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Falha ao criar draft do agent"),
  })

  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return (agents.data?.agents ?? []).filter(
      (agent) =>
        term.length === 0 ||
        agent.id.toLocaleLowerCase().includes(term) ||
        agent.description.toLocaleLowerCase().includes(term) ||
        agent.tools.some((tool) => tool.toLocaleLowerCase().includes(term)),
    )
  }, [agents.data, search])

  const selectAgent = (id: string | undefined) => {
    const next = new URLSearchParams(params)
    if (id === undefined) next.delete("selected")
    else next.set("selected", id)
    setParams(next, { replace: true })
  }

  const setNewOpen = (open: boolean) => {
    const next = new URLSearchParams(params)
    if (open && !session.canMutate) {
      next.delete("new")
      setParams(next, { replace: true })
      return
    }
    if (open) {
      next.set("new", "1")
      next.delete("selected")
    } else {
      next.delete("new")
      setNewId("")
      setNewModelProfile("")
    }
    setParams(next, { replace: true })
  }

  const editAgent = (id: string) => {
    const existing = draftByAgent.get(id)
    if (existing !== undefined) {
      void navigate(`/agent-drafts/${encodeURIComponent(existing.draft_id)}`)
      return
    }
    openDraft.mutate({ id, source: { mode: "existing" } })
  }

  const submitNew = (event: FormEvent) => {
    event.preventDefault()
    if (
      !session.canMutate ||
      !RESOURCE_ID.test(newId) ||
      newId.length > 128 ||
      !modelProfileSelected
    ) return
    openDraft.mutate({
      id: newId,
      source: { mode: "blank", model_profile: newModelProfile },
    })
  }

  const catalogDiagnostics = agents.data?.diagnostics ?? []
  const modelConfigurationHasErrors = models.data?.diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  ) ?? false
  const modelProfilesAvailable =
    !models.isError &&
    !modelConfigurationHasErrors &&
    (models.data?.profiles.length ?? 0) > 0
  const modelProfileSelected =
    modelProfilesAvailable &&
    (models.data?.profiles.some(
      (profile) => profile.id === newModelProfile,
    ) ?? false)

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Catálogo"
        title="Agents"
        description="Papéis reutilizáveis carregados de agents/&lt;id&gt;. Orchestration, gates, retry e artifacts continuam pertencendo ao workflow."
        actions={<Button disabled={!session.canMutate || drafts.isError} onClick={() => setNewOpen(true)}><FilePlus2Icon aria-hidden="true" />Novo agent</Button>}
      />
      <div className="relative max-w-md">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="pl-8"
          placeholder="Buscar por id, descrição ou tool"
          aria-label="Buscar agents"
        />
      </div>

      {agents.data?.status === "partial" && (
        <Alert variant="destructive">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>Catálogo parcial: {catalogDiagnostics.length} agent(s) inválido(s)</AlertTitle>
          <AlertDescription>
            <p>Somente agents aceitos pelo loader canônico aparecem na tabela. Corrija os itens abaixo antes de tratar a lista como completa.</p>
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

      {agents.isPending ? (
        <PageLoading label="Carregando agents" />
      ) : agents.isError ? (
        <PageError error={agents.error} retry={() => void agents.refetch()} />
      ) : filtered.length === 0 ? (
        <PageEmpty
          title={search.length > 0 ? "Nenhum agent corresponde à busca" : "Nenhum agent válido carregado"}
          description={agents.data?.status === "partial" ? "Todos os candidatos podem ter sido rejeitados; revise os diagnósticos do catálogo acima." : "O catálogo seguro não retornou um agent correspondente."}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Model profile</TableHead>
                <TableHead>Tools</TableHead>
                <TableHead>Revision</TableHead>
                <TableHead className="text-right">Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell>
                    <button
                      type="button"
                      className="max-w-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => selectAgent(agent.id)}
                    >
                      <span className="flex items-center gap-2 font-medium hover:underline">
                        <BotIcon className="size-4 text-muted-foreground" aria-hidden="true" /> {agent.id}
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">{agent.description}</span>
                    </button>
                  </TableCell>
                  <TableCell><ModeBadge mode={agent.mode} /></TableCell>
                  <TableCell className="font-mono text-xs">{agent.model_profile}</TableCell>
                  <TableCell>{agent.tools.length}</TableCell>
                  <TableCell className="font-mono text-xs">{shortDigest(agent.revision)}</TableCell>
                  <TableCell className="text-right"><Button variant="outline" size="sm" disabled={!session.canMutate || openDraft.isPending || drafts.isError} onClick={() => editAgent(agent.id)}><PencilLineIcon aria-hidden="true" />{draftByAgent.has(agent.id) ? "Abrir draft" : "Editar"}</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Sheet open={selected !== undefined} onOpenChange={(open) => { if (!open) selectAgent(undefined) }}>
        <SheetContent className="w-full sm:max-w-xl">
          {selected !== undefined && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.id}</SheetTitle>
                <SheetDescription>{selected.description}</SheetDescription>
              </SheetHeader>
              <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
                <div className="space-y-6">
                  <section className="space-y-2">
                    <h2 className="text-sm font-medium">Runtime</h2>
                    <div className="flex flex-wrap gap-2"><ModeBadge mode={selected.mode} /><Badge variant="outline">{selected.model_profile}</Badge></div>
                    <p className="text-xs text-muted-foreground">Preferred: {selected.preferred_runtime ?? "não declarado"}</p>
                  </section>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button variant="outline" onClick={() => void navigate(`/agents/${encodeURIComponent(selected.id)}/history`)}><HistoryIcon aria-hidden="true" />Histórico</Button>
                    <Button disabled={!session.canMutate || openDraft.isPending || drafts.isError} onClick={() => editAgent(selected.id)}><PencilLineIcon aria-hidden="true" />{draftByAgent.has(selected.id) ? "Abrir draft" : "Editar agent"}</Button>
                  </div>
                  <section className="space-y-2">
                    <h2 className="text-sm font-medium">Output contract</h2>
                    <p className="font-mono text-xs">{selected.output_schema_reference}</p>
                    <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(selected.output_schema, null, 2)}</pre>
                  </section>
                  <section className="space-y-2">
                    <h2 className="text-sm font-medium">Resources</h2>
                    <p className="text-xs text-muted-foreground">Tools</p>
                    <div className="flex flex-wrap gap-1">{selected.tools.length === 0 ? <span className="text-xs text-muted-foreground">Nenhuma</span> : selected.tools.map((tool) => <Badge key={tool} variant="outline">{tool}</Badge>)}</div>
                    <p className="pt-2 text-xs text-muted-foreground">Skills</p>
                    <div className="flex flex-wrap gap-1">{selected.skills.length === 0 ? <span className="text-xs text-muted-foreground">Nenhuma</span> : selected.skills.map((skill) => <Badge key={skill} variant="outline">{skill}</Badge>)}</div>
                    <p className="pt-2 text-xs text-muted-foreground">MCP configurado (não implica materialização pelo runtime)</p>
                    <div className="flex flex-wrap gap-1">{selected.mcp_servers.length === 0 ? <span className="text-xs text-muted-foreground">Nenhum</span> : selected.mcp_servers.map((server) => <Badge key={server} variant="outline">{server}</Badge>)}</div>
                  </section>
                </div>
              </ScrollArea>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <form onSubmit={submitNew} className="contents">
            <DialogHeader><DialogTitle>Novo agent reutilizável</DialogTitle><DialogDescription>Cria agent.yaml, instructions.md e output.schema.json em um draft isolado. Nada entra no projeto antes de validar, revisar o diff e confirmar apply.</DialogDescription></DialogHeader>
            <Field>
              <FieldLabel htmlFor="new-agent-id">ID do agent</FieldLabel>
              <Input id="new-agent-id" autoFocus value={newId} onChange={(event) => setNewId(event.target.value)} placeholder="meu-agent" aria-invalid={newId.length > 0 && (!RESOURCE_ID.test(newId) || newId.length > 128)} />
              <FieldDescription>O id deve coincidir com o diretório e será validado pelo loader real.</FieldDescription>
              {newId.length > 0 && (!RESOURCE_ID.test(newId) || newId.length > 128) && <FieldError>Use letras, números, ponto, hífen ou underscore; máximo 128 caracteres.</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="new-agent-model-profile">Model profile</FieldLabel>
              <NativeSelect
                id="new-agent-model-profile"
                className="w-full"
                value={newModelProfile}
                onChange={(event) => setNewModelProfile(event.target.value)}
                disabled={models.isPending || models.isError || !modelProfilesAvailable}
                aria-invalid={!models.isPending && !models.isError && !modelProfilesAvailable}
              >
                <NativeSelectOption value="">Selecione um profile</NativeSelectOption>
                {(models.data?.profiles ?? []).map((profile) => (
                  <NativeSelectOption key={profile.id} value={profile.id}>{profile.id}</NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>O profile vem de config/models.yaml e será revalidado pelo servidor ao criar o draft.</FieldDescription>
              {models.isPending && <p className="text-xs text-muted-foreground" role="status">Carregando model profiles…</p>}
              {models.isError && <FieldError>Não foi possível carregar os model profiles. Tente novamente antes de criar o agent.</FieldError>}
              {!models.isPending && !models.isError && !modelProfilesAvailable && <FieldError>Nenhum model profile válido está disponível em config/models.yaml.</FieldError>}
              {(models.data?.diagnostics.length ?? 0) > 0 && (
                <FieldError>{models.data?.diagnostics.map((diagnostic) => diagnostic.message).join(" · ")}</FieldError>
              )}
            </Field>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setNewOpen(false)}>Cancelar</Button><Button type="submit" disabled={!session.canMutate || openDraft.isPending || !RESOURCE_ID.test(newId) || newId.length > 128 || !modelProfileSelected}>{openDraft.isPending ? "Criando…" : "Criar draft"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
