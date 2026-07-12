import { useMemo, useState } from "react"
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import {
  ClipboardCopyIcon,
  FilterXIcon,
  RefreshCwIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react"
import { toast } from "sonner"

import { runLogsInfiniteQuery, studioKeys } from "@/api/queries"
import type { RunLogEntry, RunLogLevel } from "@/api/types"
import { PageError, PageLoading } from "@/components/page-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { formatDateTime } from "@/lib/format"

const LEVELS: readonly RunLogLevel[] = ["debug", "info", "warn", "error"]
const CONTEXT_RADIUS = 2

/** Runtime heartbeats are useful for forensic debugging, but obscure failures in the default view. */
function isTechnicalLog(entry: RunLogEntry): boolean {
  return /(?:heartbeat|keepalive|runtime\.stream)/i.test(entry.message)
}

function formatDiagnostic(
  runId: string,
  entries: readonly RunLogEntry[],
  filters: { readonly levels: readonly RunLogLevel[]; readonly nodeId: string; readonly search: string },
): string {
  const levelFilter = filters.levels.length === 0 ? "todos" : filters.levels.join(", ")
  const nodeFilter = filters.nodeId === "" ? "todos" : filters.nodeId
  const searchFilter = filters.search === "" ? "nenhuma" : filters.search
  const lines = entries.map((entry) => {
    const level = entry.level ?? "sem nível"
    const node = entry.node_id === undefined ? "sem node" : entry.node_id
    return `${entry.timestamp} [${level}] [${node}] ${entry.message}`
  })
  return [
    `Luna Studio — diagnóstico da execução ${runId}`,
    `Filtros: níveis=${levelFilter}; node=${nodeFilter}; busca=${searchFilter}`,
    `Entradas exibidas: ${entries.length}`,
    "",
    ...lines,
  ].join("\n")
}

function contextEntries(
  entries: readonly RunLogEntry[],
  search: string,
): readonly RunLogEntry[] {
  if (search.trim() === "") return entries
  const needle = search.trim().toLocaleLowerCase()
  const matchingIndexes = entries.flatMap((entry, index) =>
    entry.message.toLocaleLowerCase().includes(needle) ||
    entry.node_id?.toLocaleLowerCase().includes(needle) === true
      ? [index]
      : [],
  )
  if (matchingIndexes.length === 0) return []
  const included = new Set<number>()
  for (const index of matchingIndexes) {
    for (
      let candidate = Math.max(0, index - CONTEXT_RADIUS);
      candidate <= Math.min(entries.length - 1, index + CONTEXT_RADIUS);
      candidate += 1
    ) {
      included.add(candidate)
    }
  }
  return entries.filter((_, index) => included.has(index))
}

function levelBadgeVariant(level: RunLogLevel | undefined): "destructive" | "secondary" | "outline" {
  if (level === "error") return "destructive"
  if (level === "warn") return "secondary"
  return "outline"
}

export function RunLogsPanel({ runId }: { runId: string }) {
  const [levels, setLevels] = useState<RunLogLevel[]>([])
  const [nodeId, setNodeId] = useState("")
  const [search, setSearch] = useState("")
  const [showTechnical, setShowTechnical] = useState(false)
  const queryClient = useQueryClient()
  const logs = useInfiniteQuery(runLogsInfiniteQuery(runId, levels, nodeId))

  const loadedEntries = useMemo(() => {
    const bySequence = new Map(
      (logs.data?.pages ?? [])
        .flatMap((page) => page.items)
        .map((entry) => [entry.sequence, entry] as const),
    )
    return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence)
  }, [logs.data?.pages])

  const nodeOptions = useMemo(() => {
    const values = new Set(
      loadedEntries.flatMap((entry) => entry.node_id === undefined ? [] : [entry.node_id]),
    )
    return [...values].sort((left, right) => left.localeCompare(right))
  }, [loadedEntries])

  const filteredEntries = useMemo(() => {
    const nonTechnical = showTechnical
      ? loadedEntries
      : loadedEntries.filter((entry) => !isTechnicalLog(entry))
    return contextEntries(nonTechnical, search)
  }, [loadedEntries, search, showTechnical])

  const hiddenTechnicalCount = loadedEntries.filter(isTechnicalLog).length
  const activeFilterCount = levels.length + (nodeId === "" ? 0 : 1) + (search === "" ? 0 : 1)

  const toggleLevel = (level: RunLogLevel, checked: boolean) => {
    setLevels((current) =>
      checked
        ? [...new Set([...current, level])].sort()
        : current.filter((candidate) => candidate !== level),
    )
  }

  const copyDiagnostic = () => {
    const diagnostic = formatDiagnostic(runId, filteredEntries, { levels, nodeId, search })
    void navigator.clipboard.writeText(diagnostic).then(
      () => toast.success("Diagnóstico copiado"),
      () => toast.error("O navegador não permitiu copiar o diagnóstico"),
    )
  }

  const resetLogs = () => {
    void queryClient.resetQueries({
      queryKey: studioKeys.logs(runId, levels, nodeId),
      exact: true,
    })
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <TerminalIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              <h3 className="font-heading text-sm font-medium">Diagnóstico da execução</h3>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Logs agrupados por sequência. Heartbeats e eventos técnicos ficam ocultos por padrão.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={filteredEntries.length === 0}
              onClick={copyDiagnostic}
            >
              <ClipboardCopyIcon aria-hidden="true" /> Copiar diagnóstico
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={resetLogs} disabled={logs.isFetching}>
              <RefreshCwIcon aria-hidden="true" /> Atualizar
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(14rem,1fr)_12rem]">
          <label className="relative block">
            <span className="sr-only">Buscar em mensagens e nodes</span>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-8"
              placeholder="Buscar mensagem ou node…"
              aria-label="Buscar em mensagens e nodes"
            />
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            <span>Node</span>
            <NativeSelect
              value={nodeId}
              onChange={(event) => setNodeId(event.target.value)}
              className="w-full"
              aria-label="Filtrar logs por node"
            >
              <NativeSelectOption value="">Todos os nodes</NativeSelectOption>
              {nodeOptions.map((option) => <NativeSelectOption key={option} value={option}>{option}</NativeSelectOption>)}
            </NativeSelect>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
            <legend className="sr-only">Filtrar logs por nível</legend>
            {LEVELS.map((level) => (
              <Field key={level} orientation="horizontal" className="w-auto">
                <Checkbox
                  id={`run-log-${level}`}
                  checked={levels.includes(level)}
                  onCheckedChange={(checked) => toggleLevel(level, checked === true)}
                />
                <FieldLabel htmlFor={`run-log-${level}`}>{level}</FieldLabel>
              </Field>
            ))}
          </fieldset>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={showTechnical}
              onCheckedChange={setShowTechnical}
              aria-label="Mostrar eventos técnicos"
              size="sm"
            />
            <span>Mostrar técnicos{hiddenTechnicalCount > 0 ? ` (${hiddenTechnicalCount})` : ""}</span>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{filteredEntries.length} {filteredEntries.length === 1 ? "entrada" : "entradas"} exibidas</span>
          {activeFilterCount > 0 && <Badge variant="secondary">{activeFilterCount} filtros ativos</Badge>}
          {(activeFilterCount > 0 || showTechnical) && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setLevels([])
                setNodeId("")
                setSearch("")
                setShowTechnical(false)
              }}
            >
              <FilterXIcon aria-hidden="true" /> Limpar filtros
            </Button>
          )}
        </div>
      </div>

      {logs.isPending ? <PageLoading label="Carregando logs" /> : logs.isError ? <PageError error={logs.error} retry={() => void logs.refetch()} /> : filteredEntries.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="text-sm font-medium">Nenhum log corresponde aos filtros</p>
          <p className="mt-1 text-xs text-muted-foreground">Tente limpar a busca, trocar o node ou mostrar eventos técnicos.</p>
        </div>
      ) : (
        <div className="max-h-[36rem] overflow-y-auto overscroll-contain rounded-xl border bg-card font-mono text-xs shadow-sm" aria-label="Entradas de log">
          {filteredEntries.map((entry) => (
            <div
              key={entry.sequence}
              className="grid gap-2 border-b p-3 last:border-b-0 sm:grid-cols-[10rem_4.5rem_minmax(0,1fr)]"
              data-technical={isTechnicalLog(entry) ? "true" : "false"}
            >
              <span className="text-muted-foreground" title={entry.timestamp}>{formatDateTime(entry.timestamp)}</span>
              <span>{entry.level === undefined ? <Badge variant="outline">sem nível</Badge> : <Badge variant={levelBadgeVariant(entry.level)}>{entry.level}</Badge>}</span>
              <span className="min-w-0 whitespace-pre-wrap break-words">
                {entry.node_id !== undefined && <span className="mr-2 text-muted-foreground">[{entry.node_id}]</span>}
                {entry.message}
                {search.trim() !== "" && !entry.message.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) && <Badge className="ml-2" variant="outline">contexto</Badge>}
              </span>
            </div>
          ))}
        </div>
      )}
      {logs.hasNextPage && (
        <Button variant="outline" className="w-full" disabled={logs.isFetching} onClick={() => void logs.fetchNextPage()}>
          {logs.isFetchingNextPage ? "Carregando…" : "Carregar mais logs"}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">As mensagens recebem redaction best-effort no servidor. A paginação usa um snapshot verificável e mantém no máximo cinco páginas na memória.</p>
    </div>
  )
}
