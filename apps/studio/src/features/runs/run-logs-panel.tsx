import { useMemo, useState } from "react"
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCwIcon } from "lucide-react"

import { runLogsInfiniteQuery, studioKeys } from "@/api/queries"
import type { RunLogLevel } from "@/api/types"
import { PageError, PageLoading } from "@/components/page-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { formatDateTime } from "@/lib/format"

const LEVELS: readonly RunLogLevel[] = ["debug", "info", "warn", "error"]

export function RunLogsPanel({ runId }: { runId: string }) {
  const [levels, setLevels] = useState<RunLogLevel[]>([])
  const queryClient = useQueryClient()
  const logs = useInfiniteQuery(runLogsInfiniteQuery(runId, levels))
  const entries = useMemo(() => {
    const bySequence = new Map(
      (logs.data?.pages ?? [])
        .flatMap((page) => page.items)
        .map((entry) => [entry.sequence, entry] as const),
    )
    return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence)
  }, [logs.data?.pages])

  const toggleLevel = (level: RunLogLevel, checked: boolean) => {
    setLevels((current) =>
      checked
        ? [...new Set([...current, level])].sort()
        : current.filter((candidate) => candidate !== level),
    )
  }

  return (
    <div className="space-y-4">
      <fieldset className="flex flex-wrap gap-4">
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
      {logs.isPending ? <PageLoading label="Carregando logs" /> : logs.isError ? <PageError error={logs.error} retry={() => void logs.refetch()} /> : entries.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Nenhum log corresponde ao filtro.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border font-mono text-xs">
          {entries.map((entry) => (
            <div key={entry.sequence} className="grid gap-1 border-b p-3 last:border-b-0 sm:grid-cols-[11rem_4rem_1fr]">
              <span className="text-muted-foreground">{formatDateTime(entry.timestamp)}</span>
              <span>{entry.level === undefined ? "—" : <Badge variant={entry.level === "error" ? "destructive" : "outline"}>{entry.level}</Badge>}</span>
              <span className="min-w-0 whitespace-pre-wrap break-words">{entry.node_id !== undefined && <span className="mr-2 text-muted-foreground">[{entry.node_id}]</span>}{entry.message}</span>
            </div>
          ))}
        </div>
      )}
      {logs.hasNextPage && (
        <Button variant="outline" className="w-full" disabled={logs.isFetching} onClick={() => void logs.fetchNextPage()}>
          {logs.isFetchingNextPage ? "Carregando…" : "Carregar mais logs deste snapshot"}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={logs.isFetching}
        onClick={() => void queryClient.resetQueries({
          queryKey: studioKeys.logs(runId, levels),
          exact: true,
        })}
      >
        <RefreshCwIcon aria-hidden="true" /> Atualizar a partir do início
      </Button>
      <p className="text-xs text-muted-foreground">Mensagens recebem redaction best-effort no servidor. A paginação é presa a um snapshot verificável, sem polling automático, e mantém no máximo cinco páginas na memória.</p>
    </div>
  )
}
