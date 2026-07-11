import { useMemo, useState } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { SearchIcon } from "lucide-react"
import { useNavigate, useSearchParams } from "react-router-dom"

import { runsInfiniteQuery } from "@/api/queries"
import type { RunStatus } from "@/api/types"
import { PageHeader } from "@/components/page-header"
import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
import { RunStatusBadge } from "@/components/status-badge"
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
        eyebrow="RunCatalog"
        title="Runs"
        description="Execuções persistidas e correlacionadas pelo read model. Cancel, retry e resume não aparecem porque ainda não possuem contratos seguros na UI."
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative w-full max-w-md">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-8" placeholder="Buscar workflow, run, plano, adapter, subject ou repository" aria-label="Buscar runs" />
        </div>
        <NativeSelect value={status} onChange={(event) => setStatus(event.target.value as RunStatus | "all")} aria-label="Filtrar status">
          <NativeSelectOption value="all">Todos os status</NativeSelectOption>
          {["queued", "preparing", "started", "rejected", "historical_unknown", "running", "waiting_for_input", "waiting_for_retry", "resuming", "succeeded", "failed", "outcome_unknown", "timed_out", "cancelled"].map((value) => (
            <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      {planId !== undefined && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
          <Badge variant="outline">Filtro canônico por plano</Badge>
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
        <PageLoading label="Carregando runs" />
      ) : runs.isError ? (
        <PageError error={runs.error} retry={() => void runs.refetch()} />
      ) : filtered.length === 0 ? (
        <PageEmpty
          title="Nenhuma run encontrada"
          description={planId === undefined
            ? "O RunCatalog não retornou registros correspondentes aos filtros."
            : "O RunCatalog ainda não encontrou um aceite para este plano. Isso não prova rejeição; aguarde a reconciliação antes de criar outro run."}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader><TableRow><TableHead>Run</TableHead><TableHead>Status</TableHead><TableHead>Workflow</TableHead><TableHead>Origem</TableHead><TableHead>Duração</TableHead><TableHead>Completude</TableHead></TableRow></TableHeader>
            <TableBody>
              {filtered.map((run) => (
                <TableRow key={run.run_id}>
                  <TableCell>
                    <button type="button" onClick={() => void navigate(`/runs/${encodeURIComponent(run.run_id)}`)} className="max-w-xs text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="block truncate font-medium">{run.subject?.title ?? run.run_id}</span>
                      <span className="block text-xs text-muted-foreground">{formatDateTime(run.created_at)} · {shortDigest(run.run_id, 12)}</span>
                    </button>
                  </TableCell>
                  <TableCell><RunStatusBadge status={run.status} /></TableCell>
                  <TableCell><span className="font-medium">{run.workflow_id}</span>{run.workflow_revision !== undefined && <span className="block font-mono text-xs text-muted-foreground">{shortDigest(run.workflow_revision)}</span>}</TableCell>
                  <TableCell>{run.source ?? "—"}</TableCell>
                  <TableCell>{formatDuration(run.wall_duration_ms)}</TableCell>
                  <TableCell><Badge variant={run.completeness === "complete" ? "secondary" : "outline"}>{run.completeness}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {runs.hasNextPage && (
            <div className="flex justify-center border-t p-3">
              <Button
                variant="outline"
                disabled={runs.isFetchingNextPage}
                onClick={() => void runs.fetchNextPage()}
              >
                {runs.isFetchingNextPage ? "Carregando…" : "Carregar mais runs"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
