import { useMemo, useState } from "react"
import { BotIcon, BoxIcon, GitBranchIcon, NetworkIcon, PlusIcon, SearchIcon, ShieldAlertIcon } from "lucide-react"

import type {
  AgentCatalogItem,
  CapabilityCatalog,
  JsonValue,
  WorkflowSummary,
  YamlSourceOperation,
} from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { createWorkflowNodeOperations } from "@/features/workflows/workflow-node-creation"
import { composableChildWorkflows } from "@/features/workflows/workflow-composition-compatibility"
import { workflowNodeInsertionExecutionStageIssue } from "@/features/workflows/workflow-node-execution-stage"
import {
  filterWorkflowPaletteItems,
  workflowNodePaletteItems,
  workflowRecommendedPaletteItems,
  type WorkflowPaletteItem,
} from "@/features/workflows/workflow-node-catalog"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

const kindIcon = {
  built_in: BoxIcon,
  pattern: GitBranchIcon,
  agent: BotIcon,
  human_gate: ShieldAlertIcon,
  workflow: NetworkIcon,
} as const

function PaletteOption({
  item,
  issue,
  onSelect,
}: {
  item: WorkflowPaletteItem
  issue?: string
  onSelect: (item: WorkflowPaletteItem) => void
}) {
  const Icon = kindIcon[item.kind]
  return (
    <button
      type="button"
      disabled={issue !== undefined}
      title={issue}
      className="flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      onClick={() => onSelect(item)}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{item.title}</span>
          {item.requiresRepository && <Badge variant="secondary">Repositório local</Badge>}
          {item.hasExternalEffect && <Badge variant="outline">Efeito externo</Badge>}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">{item.summary}</span>
      </span>
    </button>
  )
}

export function WorkflowNodeAdd({
  source,
  nodes,
  library,
  agents,
  workflows = [],
  currentWorkflowId,
  canMutate,
  pending,
  afterNodeId,
  beforeNodeId,
  onOperations,
  onAdded,
  open: controlledOpen,
  onOpenChange,
}: {
  source: JsonValue
  nodes: readonly WorkflowSourceNode[]
  library: CapabilityCatalog
  agents: readonly AgentCatalogItem[]
  workflows?: readonly WorkflowSummary[]
  currentWorkflowId?: string
  canMutate: boolean
  pending: boolean
  afterNodeId?: string
  beforeNodeId?: string
  onOperations: (operations: readonly YamlSourceOperation[]) => void
  onAdded?: (nodeId: string) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState<string>("suggested")
  const open = controlledOpen ?? localOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next)
    onOpenChange?.(next)
    if (!next) {
      setSearch("")
      setCategory("suggested")
    }
  }
  const items = useMemo(
    () => workflowNodePaletteItems(
      library.registrations,
      agents,
      composableChildWorkflows(source, workflows),
      currentWorkflowId === undefined ? new Set() : new Set([currentWorkflowId]),
    ),
    [agents, currentWorkflowId, library.registrations, source, workflows],
  )
  const categories = useMemo(
    () => [...new Set(items.map((item) => item.category))],
    [items],
  )
  const placementIssues = useMemo(() => new Map(items.flatMap((item) => {
    const issue = workflowNodeInsertionExecutionStageIssue(
      library.registrations,
      nodes,
      { kind: item.kind, registrationId: item.id },
      afterNodeId,
      beforeNodeId,
    )
    return issue === undefined ? [] : [[`${item.kind}:${item.id}`, issue] as const]
  })), [afterNodeId, beforeNodeId, items, library.registrations, nodes])
  const placementNotices = [...new Set(placementIssues.values())]
  const createsBranch = afterNodeId !== undefined &&
    beforeNodeId === undefined &&
    nodes.some((node) => {
      const after = node.value.after
      return Array.isArray(after) && after.includes(afterNodeId)
    })
  const afterNode = nodes.find((node) => node.id === afterNodeId)
  const afterNodeTitle = items.find((item) =>
    item.id === afterNode?.registrationId && item.kind === afterNode.type,
  )?.title ?? afterNodeId
  const filtered = useMemo(() => {
    if (search.trim().length > 0) return filterWorkflowPaletteItems(items, search)
    if (category === "suggested") return workflowRecommendedPaletteItems(items)
    if (category === "all") return items
    return items.filter((item) => item.category === category)
  }, [category, items, search])
  const grouped = useMemo(() => {
    const categories = new Map<string, WorkflowPaletteItem[]>()
    for (const item of filtered) {
      categories.set(item.category, [...(categories.get(item.category) ?? []), item])
    }
    return categories
  }, [filtered])

  const select = (item: WorkflowPaletteItem) => {
    const created = createWorkflowNodeOperations({
      source,
      nodes,
      library,
      agents,
      workflows,
      kind: item.kind,
      registrationId: item.id,
      ...(afterNodeId === undefined ? {} : { afterNodeId }),
      ...(beforeNodeId === undefined ? {} : { beforeNodeId }),
    })
    if (created === undefined) return
    onOperations(created.operations)
    onAdded?.(created.id)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" disabled={!canMutate || pending} />}>
        <PlusIcon aria-hidden="true" /> Adicionar passo
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {createsBranch ? `Adicionar ramo a partir de ${afterNodeTitle}` : beforeNodeId !== undefined ? "Inserir passo na conexão" : "O que acontece em seguida?"}
          </DialogTitle>
          <DialogDescription>
            {createsBranch
              ? "Escolha o primeiro passo do novo ramo. Ele dependerá deste node e poderá executar em paralelo com os outros caminhos."
              : "Escolha uma ação, um agent, um subworkflow ou um controle de fluxo. Os requisitos técnicos são adicionados automaticamente."}
          </DialogDescription>
        </DialogHeader>
        {createsBranch && (
          <div className="flex items-start gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm">
            <GitBranchIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <p><strong>Bifurcação visual.</strong> O Studio criará uma dependência normal <code>after: [{afterNodeId}]</code>; nenhum tipo especial de branch será escondido no YAML.</p>
          </div>
        )}
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            autoFocus
            aria-label="Buscar passos"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || filtered.length !== 1) return
              const item = filtered[0]
              if (item === undefined || placementIssues.has(`${item.kind}:${item.id}`)) return
              event.preventDefault()
              select(item)
            }}
            placeholder="Buscar por ação, agent ou resultado..."
            className="pl-9"
          />
        </div>
        {search.trim().length > 0 && (
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {filtered.length === 0
              ? "Nenhum passo encontrado"
              : `${filtered.length} ${filtered.length === 1 ? "passo encontrado" : "passos encontrados"}${filtered.length === 1 ? " · Enter para adicionar" : ""}`}
          </p>
        )}
        {placementNotices.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950" role="status">
            {placementNotices.map((notice) => <p key={notice}>{notice}</p>)}
          </div>
        )}
        {search.trim().length === 0 && (
          <div className="flex flex-wrap gap-2" aria-label="Categorias de passos">
            <Button size="sm" variant={category === "suggested" ? "secondary" : "outline"} onClick={() => setCategory("suggested")}>Recomendados</Button>
            {categories.map((option) => (
              <Button key={option} size="sm" variant={category === option ? "secondary" : "outline"} onClick={() => setCategory(option)}>{option}</Button>
            ))}
            <Button size="sm" variant={category === "all" ? "secondary" : "ghost"} onClick={() => setCategory("all")}>Todos os blocos</Button>
          </div>
        )}
        <ScrollArea className="max-h-[60vh] pr-3">
          {grouped.size === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Nenhum bloco corresponde à busca.</p>
          ) : [...grouped].map(([category, options]) => (
            <section key={category} className="mb-5 last:mb-0">
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{category}</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {options.map((item) => (
                  <PaletteOption
                    key={`${item.kind}:${item.id}`}
                    item={item}
                    issue={placementIssues.get(`${item.kind}:${item.id}`)}
                    onSelect={select}
                  />
                ))}
              </div>
            </section>
          ))}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
