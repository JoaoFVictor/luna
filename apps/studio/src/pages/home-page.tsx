import { useQuery } from "@tanstack/react-query"
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  BotIcon,
  FileClockIcon,
  NetworkIcon,
  PlayIcon,
  PlusIcon,
} from "lucide-react"
import { Link } from "react-router-dom"

import { draftsQuery, runsQuery, workflowsQuery } from "@/api/queries"
import heroImage from "@/assets/hero.png"
import { useStudioSession } from "@/app/studio-context"
import { PageError, PageLoading } from "@/components/page-state"
import { DraftStatusBadge, RunStatusBadge } from "@/components/status-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { draftHref } from "@/features/drafts/draft-route"
import { formatDateTime } from "@/lib/format"

export function HomePage() {
  const session = useStudioSession()
  const workflows = useQuery(workflowsQuery)
  const drafts = useQuery(draftsQuery)
  const runs = useQuery(runsQuery)

  if (workflows.isPending && drafts.isPending && runs.isPending) {
    return <div className="p-4 sm:p-6"><PageLoading label="Carregando início" /></div>
  }

  const firstError = workflows.error ?? drafts.error ?? runs.error
  if (firstError !== null && firstError !== undefined && !workflows.data && !drafts.data && !runs.data) {
    return (
      <div className="p-4 sm:p-6">
        <PageError
          error={firstError}
          retry={() => {
            void workflows.refetch()
            void drafts.refetch()
            void runs.refetch()
          }}
        />
      </div>
    )
  }

  const recentDrafts = drafts.data?.items.slice(0, 4) ?? []
  const recentRuns = runs.data?.items.slice(0, 4) ?? []
  const diagnostics = workflows.data?.diagnostics ?? []

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <section className="relative overflow-hidden rounded-2xl border bg-linear-to-br from-card to-muted/40 p-5 sm:p-8">
        <div className="relative z-10 lg:max-w-[70%]">
          <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Projeto local</p>
          <h1 className="mt-2 max-w-3xl font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Construa, valide e aplique workflows Luna sem esconder os contratos.
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground text-pretty sm:text-base">
            O Studio usa os loaders e o compiler reais. Drafts ficam isolados até você revisar o diff e confirmar o apply.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {session.canMutate ? (
              <>
                <Link className={buttonVariants()} to="/workflows?new=1">
                  <PlusIcon aria-hidden="true" />
                  Novo workflow
                </Link>
                <Link className={buttonVariants({ variant: "outline" })} to="/agents?new=1">
                  <BotIcon aria-hidden="true" />
                  Novo agent
                </Link>
              </>
            ) : (
              <span className="self-center text-xs text-muted-foreground">
                Sessão somente leitura: criação e apply indisponíveis.
              </span>
            )}
            <Link className={buttonVariants({ variant: "outline" })} to="/workflows">
              <NetworkIcon aria-hidden="true" />
              Abrir workflows
            </Link>
            <Link className={buttonVariants({ variant: "outline" })} to="/launch">
              <PlayIcon aria-hidden="true" />
              Preparar launch
            </Link>
          </div>
        </div>
        <img
          src={heroImage}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-2 hidden w-64 -translate-y-1/2 opacity-65 lg:block xl:right-10 xl:w-72"
        />
      </section>

      {workflows.isError ? (
        <PageError error={workflows.error} retry={() => void workflows.refetch()} />
      ) : diagnostics.length > 0 && (
        <Alert variant={diagnostics.some((item) => item.severity === "error") ? "destructive" : "default"}>
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>{diagnostics.length} problema(s) no catálogo de workflows</AlertTitle>
          <AlertDescription>
            Abra Workflows para identificar o recurso e a mensagem produzida pelo loader canônico.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Drafts recentes</CardTitle>
            <CardDescription>Alterações isoladas que ainda não foram aplicadas.</CardDescription>
            <CardAction>
              <Link className={buttonVariants({ variant: "ghost", size: "sm" })} to="/workflows">
                Ver todos <ArrowRightIcon aria-hidden="true" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-1">
            {drafts.isError ? (
              <PageError error={drafts.error} retry={() => void drafts.refetch()} />
            ) : recentDrafts.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Nenhum draft local.</p>
            ) : (
              recentDrafts.map((draft, index) => (
                <div key={draft.draft_id}>
                  {index > 0 && <Separator />}
                  <Link
                    to={draftHref(draft)}
                    className="flex items-center gap-3 rounded-lg px-1 py-3 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <FileClockIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{draft.primary_resource.id}</p>
                      <p className="text-xs text-muted-foreground">Atualizado {formatDateTime(draft.updated_at)}</p>
                    </div>
                    <DraftStatusBadge status={draft.status} />
                  </Link>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Últimas execuções</CardTitle>
            <CardDescription>Read model do RunCatalog, sem varrer arquivos no navegador.</CardDescription>
            <CardAction>
              <Link className={buttonVariants({ variant: "ghost", size: "sm" })} to="/runs">
                Ver runs <ArrowRightIcon aria-hidden="true" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-1">
            {runs.isError ? (
              <PageError error={runs.error} retry={() => void runs.refetch()} />
            ) : recentRuns.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma execução registrada.</p>
            ) : (
              recentRuns.map((run, index) => (
                <div key={run.run_id}>
                  {index > 0 && <Separator />}
                  <Link
                    to={`/runs/${encodeURIComponent(run.run_id)}`}
                    className="flex items-center gap-3 rounded-lg px-1 py-3 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{run.subject?.title ?? run.workflow_id}</p>
                      <p className="text-xs text-muted-foreground">{run.workflow_id} · {formatDateTime(run.created_at)}</p>
                    </div>
                    <RunStatusBadge status={run.status} />
                  </Link>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
