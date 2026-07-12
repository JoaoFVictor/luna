import { useMemo, useState } from "react"
import { CircleIcon, EyeIcon, EyeOffIcon } from "lucide-react"

import type { RunEvent } from "@/api/types"
import { PageError, PageLoading } from "@/components/page-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { RunEventStreamStatus } from "@/features/runs/use-run-event-stream"
import { formatDateTime } from "@/lib/format"
import { humanizeTechnicalId } from "@/lib/presentation"

export function isTechnicalTimelineEvent(event: RunEvent): boolean {
  return event.event_type === "run.heartbeat"
}

function streamPresentation(status: RunEventStreamStatus, terminal: boolean) {
  if (terminal || status === "complete") return { label: "Finalizada", description: "Histórico persistido desta execução." }
  if (status === "live") return { label: "Ao vivo", description: "Novos eventos aparecem automaticamente." }
  if (status === "connecting" || status === "waiting") return { label: "Conectando", description: "Abrindo atualização em tempo real." }
  if (status === "reconnecting") return { label: "Reconectando", description: "Retomando a atualização; a consulta periódica continua ativa." }
  if (status === "invalid") return { label: "Atualização periódica", description: "O stream foi fechado porque retornou dados inválidos." }
  if (status === "unsupported") return { label: "Atualização periódica", description: "Atualização automática a cada 5 segundos." }
  return { label: "Atualização periódica", description: "Atualização automática a cada 5 segundos." }
}

export function RunTimelinePanel({
  events,
  streamStatus,
  terminal,
  pending,
  error,
  retry,
  hasPrevious,
  fetchingPrevious,
  fetchPrevious,
}: {
  events: readonly RunEvent[]
  streamStatus: RunEventStreamStatus
  terminal: boolean
  pending: boolean
  error?: Error
  retry: () => void
  hasPrevious: boolean
  fetchingPrevious: boolean
  fetchPrevious: () => void
}) {
  const stream = streamPresentation(streamStatus, terminal)
  const [showTechnical, setShowTechnical] = useState(false)
  const hiddenTechnicalCount = events.filter(isTechnicalTimelineEvent).length
  const visibleEvents = useMemo(
    () => showTechnical ? events : events.filter((event) => !isTechnicalTimelineEvent(event)),
    [events, showTechnical],
  )
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Linha do tempo</CardTitle>
          <Badge variant={streamStatus === "live" ? "secondary" : "outline"} aria-live="polite">{stream.label}</Badge>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardDescription>{stream.description}</CardDescription>
          {hiddenTechnicalCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setShowTechnical((current) => !current)}
              aria-pressed={showTechnical}
            >
              {showTechnical ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
              {showTechnical ? "Ocultar técnicos" : `Mostrar ${hiddenTechnicalCount} técnicos`}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {pending ? <PageLoading label="Carregando timeline" /> : error !== undefined ? <PageError error={error} retry={retry} /> : visibleEvents.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Nenhum evento registrado.</p>
        ) : (
          <>
            <div className="max-h-[36rem] overflow-y-auto overscroll-contain pr-2" aria-label="Eventos da execução">
            <ol>
              {visibleEvents.map((event, index) => (
                <li key={event.event_id} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2.5">
                  <div className="flex flex-col items-center"><CircleIcon className="mt-1.5 size-2 fill-foreground" aria-hidden="true" />{index < visibleEvents.length - 1 && <span className="h-full w-px bg-border" />}</div>
                  <div className="min-w-0 pb-4">
                    <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{humanizeTechnicalId(event.event_type)}</p><span className="font-mono text-[10px] text-muted-foreground">#{event.sequence}</span></div>
                    <p className="text-xs text-muted-foreground">{formatDateTime(event.occurred_at)}</p>
                    <details className="mt-1.5"><summary className="cursor-pointer text-xs text-muted-foreground">Dados do evento</summary><pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-2 text-xs">{JSON.stringify(event.data, null, 2)}</pre></details>
                  </div>
                </li>
              ))}
            </ol>
            </div>
            {hasPrevious && <Button variant="outline" size="sm" className="w-full" disabled={fetchingPrevious} onClick={fetchPrevious}>{fetchingPrevious ? "Carregando…" : "Carregar eventos anteriores"}</Button>}
          </>
        )}
      </CardContent>
    </Card>
  )
}
