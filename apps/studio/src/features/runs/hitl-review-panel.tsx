import { useEffect, useMemo, useState } from "react"
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2Icon, LoaderCircleIcon, MessageCircleMoreIcon, RefreshCcwIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"

import { describeStudioError, studioApi } from "@/api/client"
import { runInterruptsQuery, studioKeys } from "@/api/queries"
import type { RunInterrupt, RunInterruptResumeRequest } from "@/api/types"
import { useStudioSession } from "@/app/studio-context"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { InlineArtifactPreview } from "@/features/runs/artifacts-panel"
import { formatDateTime } from "@/lib/format"
import { humanizeTechnicalId } from "@/lib/presentation"

type ReviewAction = "approve" | "reject" | "request_changes"
type ReviewDecision = RunInterrupt["decision"]

function decisionAction(value: ReviewDecision): ReviewAction | undefined {
  return value?.action
}

function decisionTargets(value: ReviewDecision): readonly string[] {
  return value?.action === "request_changes" ? value.targets : []
}

function decisionComment(value: ReviewDecision): string | undefined {
  return value?.comment
}

function conversationLabel(interrupt: RunInterrupt, runActive: boolean): string {
  if (interrupt.status === "cancelled") return "Revisão cancelada"
  const action = decisionAction(interrupt.decision)
  if (!runActive) {
    return action === "approve" ? "Aprovado" : action === "reject" ? "Rejeitado" : action === "request_changes" ? "Alterações solicitadas" : "Revisão encerrada"
  }
  if (interrupt.status === "pending") return "Aguardando sua revisão"
  if (interrupt.status === "resuming") return "Aplicando decisão"
  return action === "approve" ? "Aprovado" : action === "reject" ? "Rejeitado" : action === "request_changes" ? "Alterações solicitadas" : "Revisão concluída"
}

function ReviewArtifacts({ runId, interrupt }: { runId: string; interrupt: RunInterrupt }) {
  if (interrupt.review === undefined) return null
  if (interrupt.materials_status !== "ready") {
    const pending = interrupt.materials_status === "pending"
    return (
      <Alert variant={pending ? "default" : "destructive"}>
        {pending ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <XCircleIcon aria-hidden="true" />}
        <AlertTitle>{pending ? "Materiais da revisão ainda não disponíveis" : "Materiais da revisão indisponíveis"}</AlertTitle>
        <AlertDescription>
          {interrupt.artifacts.length} de {interrupt.review.expected_artifact_count} artefatos esperados estão disponíveis. {pending
            ? "As decisões serão liberadas quando a versão estiver completa."
            : "A versão não pode ser decidida porque um material esperado falhou ou deixou de estar disponível."}
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2" aria-label="Materiais desta revisão">
      {interrupt.artifacts.map((artifact) => (
        <Card key={artifact.manifest_handle} size="sm" className="bg-background">
          <CardHeader>
            <CardTitle className="break-all text-sm">{artifact.name}</CardTitle>
            <CardDescription>{artifact.media_type}</CardDescription>
          </CardHeader>
          <CardContent>
            <InlineArtifactPreview runId={runId} artifact={artifact} />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function ReviewHistory({
  runId,
  items,
  runActive,
}: {
  runId: string
  items: readonly RunInterrupt[]
  runActive: boolean
}) {
  return (
    <ol className="space-y-3" aria-label="Histórico da revisão">
      {items.map((interrupt, index) => {
        const action = decisionAction(interrupt.decision)
        const comment = decisionComment(interrupt.decision)
        const selectedTargets = new Set(decisionTargets(interrupt.decision))
        const targetLabels = interrupt.review?.targets
          .filter((target) => selectedTargets.has(target.id))
          .map((target) => target.label) ?? []
        return (
          <li key={interrupt.interrupt_id} className="grid gap-2 sm:grid-cols-[2.25rem_minmax(0,1fr)]">
            <div className="flex size-9 items-center justify-center rounded-full border bg-background text-xs font-semibold" aria-hidden="true">
              {index + 1}
            </div>
            <div className="min-w-0 space-y-2 rounded-2xl rounded-tl-sm border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={action === "reject" ? "secondary" : action === "approve" ? "default" : "outline"}>
                    {conversationLabel(interrupt, runActive)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{humanizeTechnicalId(interrupt.node_id)}</span>
                </div>
                <time className="text-xs text-muted-foreground" dateTime={interrupt.updated_at}>
                  {formatDateTime(interrupt.updated_at)}
                </time>
              </div>
              <p className="whitespace-pre-wrap text-sm">{interrupt.prompt}</p>
              {comment !== undefined && (
                <div className="ml-auto max-w-[90%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
                  <span className="sr-only">Comentário humano: </span>{comment}
                </div>
              )}
              {targetLabels.length > 0 && (
                <div className="ml-auto flex max-w-[90%] flex-wrap justify-end gap-1" aria-label="Áreas solicitadas">
                  {targetLabels.map((label) => <Badge key={label} variant="outline">{label}</Badge>)}
                </div>
              )}
              <ReviewArtifacts runId={runId} interrupt={interrupt} />
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export function HitlReviewPanel({
  runId,
  active,
  terminalAt,
}: {
  runId: string
  active: boolean
  terminalAt?: string
}) {
  const session = useStudioSession()
  const queryClient = useQueryClient()
  const interrupts = useInfiniteQuery(runInterruptsQuery(runId, active, terminalAt))
  const [comment, setComment] = useState("")
  const [selectedTargets, setSelectedTargets] = useState<readonly string[]>([])
  const ordered = useMemo(
    () => [...new Map(
      (interrupts.data?.pages ?? [])
        .flatMap((page) => page.items)
        .map((item) => [item.interrupt_id, item] as const),
    ).values()].sort((left, right) => left.created_at.localeCompare(right.created_at)),
    [interrupts.data?.pages],
  )
  const pending = active
    ? [...ordered].reverse().find((item) => item.status === "pending")
    : undefined
  const current = ordered.at(-1)
  const resuming = active && current?.status === "resuming"
  useEffect(() => {
    setComment("")
    setSelectedTargets([])
  }, [pending?.interrupt_id])
  const resume = useMutation({
    mutationFn: async ({ interrupt, input }: {
      interrupt: RunInterrupt
      input: RunInterruptResumeRequest
    }) => studioApi.resumeRunInterrupt(runId, interrupt.interrupt_id, input),
    onSuccess: async (receipt, variables) => {
      setComment("")
      setSelectedTargets([])
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: studioKeys.runInterrupts(runId) }),
        queryClient.invalidateQueries({ queryKey: studioKeys.run(runId) }),
        queryClient.invalidateQueries({ queryKey: studioKeys.timeline(runId) }),
        queryClient.invalidateQueries({ queryKey: studioKeys.artifacts(runId) }),
      ])
      if (receipt.already_resumed) {
        toast.info("Esta aprovação já havia sido recebida")
      } else if (variables.input.action === "reject") {
        toast.success("Revisão rejeitada e encerrada")
      } else if (variables.input.action === "request_changes") {
        toast.success("Alterações solicitadas")
      } else {
        toast.success("Conteúdo aprovado para continuar")
      }
    },
    onError: (error) => {
      const described = describeStudioError(error)
      toast.error(described.title, { description: described.message })
    },
  })

  if (interrupts.isPending) return null
  if (interrupts.isError) {
    return (
      <Alert variant="destructive">
        <XCircleIcon aria-hidden="true" />
        <AlertTitle>Não foi possível carregar a revisão humana</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>O histórico e a decisão pendente não estão disponíveis no momento.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={interrupts.isFetching}
            onClick={() => void interrupts.refetch()}
          >
            {interrupts.isFetching && (
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            )}
            Tentar novamente
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (ordered.length === 0) return null
  const trimmedComment = comment.trim()
  const materialsUnavailable = pending?.materials_status !== "ready"
  const disabled = !session.canMutate || pending === undefined || resume.isPending || resuming || materialsUnavailable
  const resumeFailure = resume.isError ? describeStudioError(resume.error) : undefined

  return (
    <Card className="border-primary/30 bg-primary/[0.025]" aria-labelledby="human-review-title">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle id="human-review-title" className="flex items-center gap-2">
              <MessageCircleMoreIcon className="size-5" aria-hidden="true" /> Revisão humana
            </CardTitle>
            <CardDescription className="mt-1">
              Converse com o workflow sobre os materiais apresentados, solicite alterações ou encerre a revisão.
            </CardDescription>
          </div>
          {pending !== undefined && <Badge>Decisão pendente</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <ReviewHistory runId={runId} items={ordered} runActive={active} />

        {interrupts.hasNextPage && (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              disabled={interrupts.isFetchingNextPage}
              onClick={() => void interrupts.fetchNextPage()}
            >
              {interrupts.isFetchingNextPage
                ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                : <RefreshCcwIcon aria-hidden="true" />}
              Carregar revisões anteriores
            </Button>
          </div>
        )}

        {resuming && (
          <Alert>
            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            <AlertTitle>Agent trabalhando na próxima etapa</AlertTitle>
            <AlertDescription>
              A decisão foi recebida. O Studio continuará acompanhando a execução e atualizará esta revisão quando houver novos outputs.
            </AlertDescription>
          </Alert>
        )}

        {resumeFailure !== undefined && (
          <Alert variant="destructive">
            <XCircleIcon aria-hidden="true" />
            <AlertTitle>{resumeFailure.title}</AlertTitle>
            <AlertDescription>
              <p>{resumeFailure.message}</p>
              {resumeFailure.code !== undefined && (
                <p className="mt-2 font-mono text-xs">Código: {resumeFailure.code}</p>
              )}
            </AlertDescription>
          </Alert>
        )}

        {pending !== undefined && (
          <form className="space-y-3" onSubmit={(event) => event.preventDefault()}>
            {pending.review !== undefined && (
              <fieldset className="space-y-2" disabled={disabled}>
                <legend className="text-sm font-medium">O que deve ser alterado?</legend>
                <div className="flex flex-wrap gap-3">
                  {pending.review.targets.map((target) => (
                    <label key={target.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                      <Checkbox
                        checked={selectedTargets.includes(target.id)}
                        onCheckedChange={(checked) => setSelectedTargets((current) => checked === true
                          ? [...current, target.id]
                          : current.filter((id) => id !== target.id))}
                      />
                      {target.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <label htmlFor="human-review-comment" className="text-sm font-medium">Mensagem</label>
            <Textarea
              id="human-review-comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Descreva o ajuste desejado ou deixe um comentário sobre sua decisão"
              rows={4}
              maxLength={4_096}
              disabled={disabled}
            />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => resume.mutate({
                  interrupt: pending,
                  input: {
                    action: "reject",
                    ...(trimmedComment.length === 0 ? {} : { comment: trimmedComment }),
                  },
                })}
              >
                <XCircleIcon aria-hidden="true" /> Rejeitar e encerrar
              </Button>
              {pending.review !== undefined && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled || trimmedComment.length === 0 || selectedTargets.length === 0}
                  onClick={() => resume.mutate({
                    interrupt: pending,
                    input: {
                      action: "request_changes",
                      comment: trimmedComment,
                      targets: [...selectedTargets],
                    },
                  })}
                >
                  <RefreshCcwIcon aria-hidden="true" /> Solicitar alterações
                </Button>
              )}
              <Button
                type="button"
                disabled={disabled}
                onClick={() => resume.mutate({
                  interrupt: pending,
                  input: {
                    action: "approve",
                    ...(trimmedComment.length === 0 ? {} : { comment: trimmedComment }),
                  },
                })}
              >
                <CheckCircle2Icon aria-hidden="true" /> Aprovar
              </Button>
            </div>
            {!session.canMutate && <p className="text-xs text-destructive">A sessão atual é somente leitura; reabra o Studio com uma sessão mutável para decidir.</p>}
            {materialsUnavailable && <p className="text-xs text-muted-foreground">Aprovar, rejeitar e solicitar alterações ficam indisponíveis até todos os materiais desta revisão estarem prontos.</p>}
          </form>
        )}
      </CardContent>
    </Card>
  )
}
