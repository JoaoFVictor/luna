import { useEffect, useMemo, useState } from "react"
import { BotIcon, SaveIcon, SearchIcon, ShieldAlertIcon, WrenchIcon } from "lucide-react"

import type {
  AgentCatalogItem,
  CapabilityCatalog,
  JsonValue,
  RuntimeConfiguration,
  YamlSourceOperation,
} from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  agentResourcesOperations,
  parseSubagents,
  uniqueTrimmedLines,
  type AgentDefinitionView,
} from "@/features/agents/agent-definition-model"
import { useServerBackedForm } from "@/features/agents/use-server-backed-form"
import {
  agentToolAllowed,
  localAgentTools,
  type AgentToolRegistration,
} from "@/features/agents/agent-tool-authority"
import { humanizeTechnicalId } from "@/lib/presentation"

type ResourcesDraft = {
  readonly contextFiles: string
  readonly skills: string
  readonly tools: readonly string[]
  readonly mcpServers: string
  readonly subagents: string
  readonly runtimeRequirements: string
  readonly preferredRuntime: string
  readonly runtimeOrder: string
}

function resourcesDraft(agent: AgentDefinitionView): ResourcesDraft {
  return {
    contextFiles: agent.contextFiles.join("\n"),
    skills: agent.skills.join("\n"),
    tools: [...agent.tools],
    mcpServers: agent.mcpServers.join("\n"),
    subagents: JSON.stringify(agent.subagents, null, 2),
    runtimeRequirements: agent.runtimeRequirements.join("\n"),
    preferredRuntime: agent.preferredRuntime,
    runtimeOrder: agent.runtimeOrder.join("\n"),
  }
}

function subagentId(value: JsonValue): string | undefined {
  if (typeof value === "string") return value
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined
  return typeof value.id === "string" ? value.id : undefined
}

function ToolPicker({
  tools,
  selected,
  mode,
  disabled,
  onChange,
}: {
  tools: readonly AgentToolRegistration[]
  selected: readonly string[]
  mode: AgentDefinitionView["mode"]
  disabled: boolean
  onChange: (tools: readonly string[]) => void
}) {
  const selectedSet = new Set(selected)
  const [search, setSearch] = useState("")
  const term = search.trim().toLocaleLowerCase()
  const visibleTools = tools.filter((tool) =>
    term.length === 0 ||
    tool.id.toLocaleLowerCase().includes(term) ||
    tool.presentation.title.toLocaleLowerCase().includes(term) ||
    tool.presentation.summary?.toLocaleLowerCase().includes(term) === true,
  )
  return (
    <div className="space-y-3">
      <div className="relative max-w-md">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-8" placeholder="Buscar pelo que o agent precisa fazer" aria-label="Buscar ferramentas" />
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
      {visibleTools.map((tool) => {
        const checked = selectedSet.has(tool.id)
        const allowed = agentToolAllowed(tool, mode)
        const authorityAvailable = tool.allowed_agent_modes !== undefined
        const title = tool.presentation.title === tool.id
          ? humanizeTechnicalId(tool.id)
          : tool.presentation.title
        return (
          <label key={tool.id} className="flex gap-3 rounded-lg border p-3 text-sm">
            <Checkbox
              checked={checked}
              disabled={disabled || (!checked && !allowed)}
              aria-label={`${checked ? "Remover" : "Adicionar"} tool ${tool.id}`}
              onCheckedChange={(next) => onChange(next === true
                ? [...selected, tool.id]
                : selected.filter((id) => id !== tool.id))}
            />
            <span className="min-w-0 flex-1 space-y-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{title}</span>
                <Badge variant="outline">Ferramenta local</Badge>
                {!authorityAvailable && <Badge variant="destructive">Permissão desconhecida</Badge>}
                {authorityAvailable && !allowed && <Badge variant="destructive">Incompatível com esta permissão</Badge>}
                {tool.safety?.local_writes && <Badge variant="destructive">Edita arquivos</Badge>}
                {tool.safety?.network && <Badge variant="destructive">Acessa a rede</Badge>}
                {tool.safety?.external_side_effects && <Badge variant="destructive">Efeito externo</Badge>}
              </span>
              <span className="block text-xs text-muted-foreground">{tool.presentation.summary ?? tool.presentation.title}</span>
              <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">ID técnico</summary><code>{tool.id}</code></details>
            </span>
          </label>
        )
      })}
      {tools.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma ferramenta local registrada no catálogo carregado.</p>}
      {tools.length > 0 && visibleTools.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma ferramenta corresponde à busca.</p>}
      </div>
    </div>
  )
}

export function AgentResourcesSection({
  agent,
  agentId,
  library,
  agents,
  runtime,
  disabled,
  pending,
  onDirtyChange,
  onSave,
}: {
  agent: AgentDefinitionView
  agentId: string
  library?: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
  runtime?: RuntimeConfiguration
  disabled: boolean
  pending: boolean
  onDirtyChange: (dirty: boolean) => void
  onSave: (operations: readonly YamlSourceOperation[]) => void
}) {
  const serverForm = useMemo(() => resourcesDraft(agent), [agent])
  const form = useServerBackedForm(serverForm)
  const [subagentError, setSubagentError] = useState<string>()
  const parsedSubagents = parseSubagents(form.value.subagents)
  const localTools = useMemo(() => localAgentTools(library), [library])
  const knownToolIds = new Set(localTools.map((tool) => tool.id))
  const unknownTools = form.value.tools.filter((id) => !knownToolIds.has(id))
  const incompatibleTools = localTools.filter(
    (tool) => form.value.tools.includes(tool.id) && !agentToolAllowed(tool, agent.mode),
  )
  const resourceValue = parsedSubagents.ok ? {
    contextFiles: uniqueTrimmedLines(form.value.contextFiles),
    skills: uniqueTrimmedLines(form.value.skills),
    tools: form.value.tools,
    mcpServers: uniqueTrimmedLines(form.value.mcpServers),
    subagents: parsedSubagents.value,
    runtimeRequirements: uniqueTrimmedLines(form.value.runtimeRequirements),
    preferredRuntime: form.value.preferredRuntime,
    runtimeOrder: uniqueTrimmedLines(form.value.runtimeOrder),
  } : undefined
  const operations = resourceValue === undefined
    ? []
    : agentResourcesOperations(agent, resourceValue)
  const semanticallyDirty = operations.length > 0 || (form.dirty && !parsedSubagents.ok)

  useEffect(() => onDirtyChange(semanticallyDirty), [onDirtyChange, semanticallyDirty])

  const addSubagent = (id: string) => {
    if (!parsedSubagents.ok) {
      setSubagentError(parsedSubagents.message)
      return
    }
    if (parsedSubagents.value.some((item) => subagentId(item) === id)) return
    setSubagentError(undefined)
    form.setValue({
      ...form.value,
      subagents: JSON.stringify([...parsedSubagents.value, id], null, 2),
    })
  }

  return (
    <div className="space-y-6">
      <Alert>
        <ShieldAlertIcon aria-hidden="true" />
        <AlertTitle>Escolha somente o que este agent realmente precisa</AlertTitle>
        <AlertDescription>Recursos de escrita e integrações elevam a autoridade do agent e podem exigir confirmação ao executar.</AlertDescription>
      </Alert>
      {!agent.modeIsKnown && (
        <Alert variant="destructive">
          <ShieldAlertIcon aria-hidden="true" />
          <AlertTitle>Escolha uma permissão válida primeiro</AlertTitle>
          <AlertDescription>Volte a Identidade, selecione a permissão e salve antes de adicionar recursos.</AlertDescription>
        </Alert>
      )}

      <section className="space-y-4" aria-labelledby="agent-context-resources">
        <div><h2 id="agent-context-resources" className="text-sm font-semibold">Conhecimento e orientações</h2><p className="text-xs text-muted-foreground">Arquivos que ajudam o agent a entender o projeto e seguir procedimentos específicos.</p></div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="agent-context-files">Arquivos de contexto</FieldLabel>
            <Textarea id="agent-context-files" value={form.value.contextFiles} disabled={disabled} className="min-h-28 font-mono text-xs" onChange={(event) => form.setValue({ ...form.value, contextFiles: event.target.value })} />
            <FieldDescription>Só entram na execução quando o workflow coleta e passa context explicitamente.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="agent-skills">Procedimentos (skills)</FieldLabel>
            <Textarea id="agent-skills" value={form.value.skills} disabled={disabled} className="min-h-28 font-mono text-xs" onChange={(event) => form.setValue({ ...form.value, skills: event.target.value })} />
            <FieldDescription>Paths para `SKILL.md`; não confundir com skills configuradas pelo repository.</FieldDescription>
          </Field>
        </div>
      </section>

      <Separator />

      <section className="space-y-4" aria-labelledby="agent-tools">
        <div><h2 id="agent-tools" className="flex items-center gap-2 text-sm font-semibold"><WrenchIcon className="size-4" aria-hidden="true" /> Ferramentas</h2><p className="text-xs text-muted-foreground">Ações locais que o agent poderá solicitar durante a execução.</p></div>
        <ToolPicker tools={localTools} selected={form.value.tools} mode={agent.mode} disabled={disabled} onChange={(tools) => form.setValue({ ...form.value, tools })} />
        {unknownTools.length > 0 && <Alert variant="destructive"><AlertTitle>Tools sem registro carregado</AlertTitle><AlertDescription><p>Foram preservadas e não podem ser adicionadas novamente sem o plugin correspondente.</p><div className="mt-2 flex flex-wrap gap-2">{unknownTools.map((id) => <Button key={id} size="xs" variant="outline" disabled={disabled} onClick={() => form.setValue({ ...form.value, tools: form.value.tools.filter((tool) => tool !== id) })}>Remover {id}</Button>)}</div></AlertDescription></Alert>}
        {incompatibleTools.length > 0 && <FieldError>Remova as tools incompatíveis com {agent.mode}: {incompatibleTools.map((tool) => tool.id).join(", ")}.</FieldError>}
      </section>

      <Separator />

      <section className="space-y-4" aria-labelledby="agent-mcp-subagents">
        <div><h2 id="agent-mcp-subagents" className="flex items-center gap-2 text-sm font-semibold"><BotIcon className="size-4" aria-hidden="true" /> Integrações e outros agents</h2><p className="text-xs text-muted-foreground">Permita que este agent use servidores MCP ou delegue tarefas.</p></div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="agent-mcp-servers">Servidores MCP</FieldLabel>
            <Textarea id="agent-mcp-servers" value={form.value.mcpServers} disabled={disabled} className="min-h-32 font-mono text-xs" onChange={(event) => form.setValue({ ...form.value, mcpServers: event.target.value })} />
            <FieldDescription>O Studio não expõe credenciais nem transports de `mcp.yaml`. No Pi atual, MCP configura policy mas não é materializado.</FieldDescription>
          </Field>
          <Field data-invalid={!parsedSubagents.ok || subagentError !== undefined}>
            <FieldLabel htmlFor="agent-subagents">Agents auxiliares (avançado)</FieldLabel>
            <Textarea id="agent-subagents" value={form.value.subagents} disabled={disabled} className="min-h-32 font-mono text-xs" onChange={(event) => { setSubagentError(undefined); form.setValue({ ...form.value, subagents: event.target.value }) }} />
            <FieldDescription>Use ids ou objetos `{"{ id, policy: { mode, allow_tools } }"}`. A execução depende do runtime.</FieldDescription>
            {!parsedSubagents.ok && <FieldError>{parsedSubagents.message}</FieldError>}
            {subagentError !== undefined && <FieldError>{subagentError}</FieldError>}
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          {agents.filter((candidate) => candidate.id !== agentId).map((candidate) => (
            <Button key={candidate.id} size="sm" variant="outline" disabled={disabled || !parsedSubagents.ok || parsedSubagents.value.some((item) => subagentId(item) === candidate.id)} onClick={() => addSubagent(candidate.id)}>
              <BotIcon aria-hidden="true" /> {candidate.id}
            </Button>
          ))}
          {agents.filter((candidate) => candidate.id !== agentId).length === 0 && <span className="text-xs text-muted-foreground">Nenhum outro agent carregado no catálogo.</span>}
        </div>
      </section>

      <Separator />

      <section className="space-y-4" aria-labelledby="agent-runtime-resources">
        <div><h2 id="agent-runtime-resources" className="text-sm font-semibold">Runtime avançado</h2><p className="text-xs text-muted-foreground">Runtime ativo: {runtime?.agent_runtime_id ?? "indisponível"}. Use apenas quando este agent depender de um executor específico.</p></div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="agent-runtime-requirements">Requirements</FieldLabel>
            <Textarea id="agent-runtime-requirements" value={form.value.runtimeRequirements} disabled={disabled} className="min-h-28 font-mono text-xs" onChange={(event) => form.setValue({ ...form.value, runtimeRequirements: event.target.value })} />
            <FieldDescription>Um id por linha. Tools também podem derivar requirements automaticamente.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="agent-preferred-runtime">Preferred runtime</FieldLabel>
            <Input id="agent-preferred-runtime" value={form.value.preferredRuntime} disabled={disabled} onChange={(event) => form.setValue({ ...form.value, preferredRuntime: event.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="agent-runtime-order">Runtime order</FieldLabel>
            <Textarea id="agent-runtime-order" value={form.value.runtimeOrder} disabled={disabled} className="min-h-28 font-mono text-xs" onChange={(event) => form.setValue({ ...form.value, runtimeOrder: event.target.value })} />
            <FieldDescription>Um runtime id por linha.</FieldDescription>
          </Field>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={disabled || pending || operations.length === 0 || !parsedSubagents.ok || incompatibleTools.length > 0} onClick={() => onSave(operations)}>
          <SaveIcon aria-hidden="true" />{pending ? "Salvando…" : "Salvar recursos"}
        </Button>
        {form.dirty && <Button variant="ghost" onClick={form.reset}>Descartar alterações</Button>}
        {operations.length === 0 && <Badge variant="outline">sincronizado</Badge>}
      </div>
    </div>
  )
}
