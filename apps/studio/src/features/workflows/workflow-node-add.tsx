import { useMemo, useState } from "react"
import { BotIcon, BoxIcon, GitBranchIcon, PlusIcon, SearchIcon, ShieldAlertIcon } from "lucide-react"

import type {
  AgentCatalogItem,
  CapabilityCatalog,
  JsonValue,
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
import {
  workflowNodePaletteItems,
  type WorkflowPaletteItem,
} from "@/features/workflows/workflow-node-catalog"
import type { WorkflowSourceNode } from "@/features/workflows/workflow-source-model"

const kindIcon = {
  built_in: BoxIcon,
  pattern: GitBranchIcon,
  agent: BotIcon,
  human_gate: ShieldAlertIcon,
} as const

function PaletteOption({
  item,
  onSelect,
}: {
  item: WorkflowPaletteItem
  onSelect: (item: WorkflowPaletteItem) => void
}) {
  const Icon = kindIcon[item.kind]
  return (
    <button
      type="button"
      className="flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onSelect(item)}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{item.title}</span>
          {item.hasExternalEffect && <Badge variant="outline">Efeito externo</Badge>}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">{item.summary}</span>
        <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{item.id}</span>
      </span>
    </button>
  )
}

export function WorkflowNodeAdd({
  source,
  nodes,
  library,
  agents,
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
  const open = controlledOpen ?? localOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next)
    onOpenChange?.(next)
    if (!next) setSearch("")
  }
  const items = useMemo(
    () => workflowNodePaletteItems(library.registrations, agents),
    [agents, library.registrations],
  )
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return term.length === 0
      ? items
      : items.filter((item) =>
          [item.title, item.summary, item.category, item.id, ...item.tags]
            .some((value) => value.toLocaleLowerCase().includes(term)),
        )
  }, [items, search])
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
          <DialogTitle>O que acontece em seguida?</DialogTitle>
          <DialogDescription>
            Escolha uma ação, um agent ou um controle de fluxo. Os requisitos técnicos são adicionados automaticamente.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por ação, agent ou resultado..."
            className="pl-9"
          />
        </div>
        <ScrollArea className="max-h-[60vh] pr-3">
          {grouped.size === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Nenhum bloco corresponde à busca.</p>
          ) : [...grouped].map(([category, options]) => (
            <section key={category} className="mb-5 last:mb-0">
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{category}</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {options.map((item) => <PaletteOption key={`${item.kind}:${item.id}`} item={item} onSelect={select} />)}
              </div>
            </section>
          ))}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
