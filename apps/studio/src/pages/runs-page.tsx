import { useMemo, useState } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { SearchIcon } from "lucide-react"
import { useNavigate, useSearchParams } from "react-router-dom"

import { runsInfiniteQuery } from "@/api/queries"
import type { RunStatus, RunSummary } from "@/api/types"
import { PageHeader } from "@/components/page-header"
import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
import { RunStatusBadge, runStatusLabel } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { formatDateTime, formatDuration, shortDigest } from "@/lib/format"
import { humanizeTechnicalId } from "@/lib/presentation"

function runTitle(run: RunSummary): string {
  return run.subject?.title ?? `${humanizeTechnicalId(run.workflow_id)} · ${formatDateTime(run.created_at)}`
}

function runOrigin(run: RunSummary): string {
  return run.input_provenance?.kind === "adapter"
    ? humanizeTechnicalId(run.input_provenance.adapter_id)
    : run.source === undefined
      ? "Entrada direta"
      : humanizeTechnicalId(run.source)
}

function RunCard({ run, onOpen }: { run: RunSummary; onOpen: () => void }) {
  return (
    <article className="rounded-xl border bg-card p-3 shadow-xs">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="block truncate font-medium hover:underline">{runTitle(run)}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {formatDateTime(run.created_at)} · {shortDigest(run.run_id, 12)}
          </span>
        </button>
        <RunStatusBadge status={run.status} />
      </div>
      <dl className="mt-3 grid gap-3 border-t pt-3 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-xs font-medium text-muted-foreground">Workflow</dt>
          <dd className="mt-1 truncate font-medium">{humanizeTechnicalId(run.workflow_id)}</dd>
          {run.workflow_revision !== undefined && (
            <dd className="font-mono text-xs text-muted-foreground">{shortDigest(run.workflow_revision)}</dd>
          )}
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-medium text-muted-foreground">Origem</dt>
          <dd className="mt-1 truncate">{runOrigin(run)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted-foreground">Duração</dt>
          <dd className="mt-1">{formatDuration(run.wall_duration_ms)}</dd>
        </div>
      </dl>
    </article>
  )
}

export function RunsPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const planId = params.get("plan_id") ?? undefined
  const [search, setSearch] = useState(planId ?? "")
  const [status, setStatus] = useState<RunStatus | "all">("all")
  const runs = useInfiniteQuery(
    runsInfiniteQuery({
      ...(status === "all" ? {} : { status }),
      ...(planId === undefined ? {} : { planId }),
    }),
  )
  const loadedRuns = useMemo(
    () => runs.data?.pages.flatMap((page) => page.items) ?? [],
    [runs.data?.pages],
  )

  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return loadedRuns.filter(
      (run) =>
        (term.length === 0 ||
          run.run_id.toLocaleLowerCase().includes(term) ||
          run.accepted_plan_id?.toLocaleLowerCase().includes(term) === true ||
          run.workflow_id.toLocaleLowerCase().includes(term) ||
          run.subject?.title?.toLocaleLowerCase().includes(term) === true ||
          run.repository_id?.toLocaleLowerCase().includes(term) === true ||
          (run.input_provenance?.kind === "adapter" &&
            run.input_provenance.adapter_id.toLocaleLowerCase().includes(term))),
    )
  }, [loadedRuns, search])

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Histórico e acompanhamento"
        title="Execuções"
        description="Acompanhe o que está rodando, encontre falhas e abra os resultados de cada workflow."
      />
      <div className="sticky top-0 z-20 -mx-4 flex flex-col gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:flex-row sm:px-6">
        <div className="relative w-full max-w-md">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-8" placeholder="Buscar por workflow, assunto ou origem" aria-label="Buscar execuções" />
        </div>
        <NativeSelect value={status} onChange={(event) => setStatus(event.target.value as RunStatus | "all")} aria-label="Filtrar status">
          <NativeSelectOption value="all">Todos os status</NativeSelectOption>
          {["queued", "preparing", "started", "rejected", "historical_unknown", "running", "waiting_for_input", "waiting_for_retry", "resuming", "succeeded", "failed", "outcome_unknown", "timed_out", "cancelled"].map((value) => (
            <NativeSelectOption key={value} value={value}>{runStatusLabel(value as RunStatus)}</NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      {planId !== undefined && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
          <Badge variant="outline">Execuções deste plano</Badge>
          <code className="break-all">{planId}</code>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = new URLSearchParams(params)
              next.delete("plan_id")
              setParams(next, { replace: true })
              setSearch("")
            }}
          >
            Limpar filtro
          </Button>
        </div>
      )}

      {runs.isPending ? (
        <PageLoading label="Carregando execuções" />
      ) : runs.isError ? (
        <PageError error={runs.error} retry={() => void runs.refetch()} />
      ) : filtered.length === 0 ? (
        <PageEmpty
          title="Nenhuma execução encontrada"
          description={planId === undefined
            ? "Nenhuma execução corresponde aos filtros atuais."
            : "A execução deste plano ainda não apareceu. Aguarde alguns instantes antes de iniciar outra."}
        />
      ) : (
        <>
          <div className="space-y-2 min-[1400px]:hidden" aria-label="Lista de execuções">
            {filtered.map((run) => (
              <RunCard
                key={run.run_id}
                run={run}
                onOpen={() => void navigate(`/runs/${encodeURIComponent(run.run_id)}`)}
              />
            ))}
          </div>
          <div className="hidden overflow-hidden rounded-xl border min-[1400px]:block">
            <Table>
              <TableHeader><TableRow><TableHead>Execução</TableHead><TableHead>Status</TableHead><TableHead>Workflow</TableHead><TableHead>Origem</TableHead><TableHead>Duração</TableHead></TableRow></TableHeader>
              <TableBody>
                {filtered.map((run) => (
                  <TableRow key={run.run_id}>
                    <TableCell>
                      <button type="button" onClick={() => void navigate(`/runs/${encodeURIComponent(run.run_id)}`)} className="max-w-xs text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                        <span className="block truncate font-medium">{runTitle(run)}</span>
                        <span className="block text-xs text-muted-foreground">{formatDateTime(run.created_at)} · {shortDigest(run.run_id, 12)}</span>
                      </button>
                    </TableCell>
                    <TableCell><RunStatusBadge status={run.status} /></TableCell>
                    <TableCell><span className="font-medium">{humanizeTechnicalId(run.workflow_id)}</span>{run.workflow_revision !== undefined && <span className="block font-mono text-xs text-muted-foreground">{shortDigest(run.workflow_revision)}</span>}</TableCell>
                    <TableCell>{runOrigin(run)}</TableCell>
                    <TableCell>{formatDuration(run.wall_duration_ms)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {runs.hasNextPage && (
            <div className="flex justify-center border-t p-3">
              <Button
                variant="outline"
                disabled={runs.isFetchingNextPage}
                onClick={() => void runs.fetchNextPage()}
              >
                {runs.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
