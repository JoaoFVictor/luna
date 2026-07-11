import {
  CircleAlertIcon,
  Clock3Icon,
  ExternalLinkIcon,
  PlayIcon,
  ShieldAlertIcon,
} from "lucide-react"
import { Link } from "react-router-dom"

import type {
  RunPlan,
} from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { formatDateTime } from "@/lib/format"
import type { RunLaunchNotice } from "@/features/launch/use-run-launch"

type ConfirmationProps = {
  plan: RunPlan
  canMutate: boolean
  expired: boolean
  executing: boolean
  acceptanceUnknown: boolean
  realRunConfirmed: boolean
  listedEffectsConfirmed: boolean
  onRealRunConfirmedChange: (value: boolean) => void
  onListedEffectsConfirmedChange: (value: boolean) => void
  onExecute: () => void
}

function ExactValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all font-mono text-xs">{value}</dd>
    </div>
  )
}

function PlanIdentity({ plan }: { plan: RunPlan }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Plano autoritativo</CardTitle>
            <CardDescription>
              Gerado pelo backend com a configuração instalada e revalidado antes do dispatch.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{plan.mode}</Badge>
            <Badge variant={plan.confirmation_required ? "destructive" : "secondary"}>
              {plan.confirmation_required ? "efeitos exigem confirmação" : "sem write declarado"}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-4 sm:grid-cols-2">
          <ExactValue label="Workflow" value={plan.workflow_id} />
          <ExactValue label="Workflow revision" value={plan.workflow_revision} />
          <ExactValue label="Definition bundle" value={plan.definition_bundle_hash} />
          <ExactValue label="Catalog fingerprint" value={plan.catalog_fingerprint} />
          <ExactValue label="Execution snapshot" value={plan.execution_snapshot_hash} />
          <ExactValue label="Invocation hash" value={plan.invocation_hash} />
          <ExactValue label="Config hash" value={plan.config_hash} />
          <ExactValue label="Plan ID" value={plan.plan_id} />
        </dl>

        <Separator />

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Validade</p>
            <p className="mt-1 flex items-center gap-2 text-sm">
              <Clock3Icon className="size-4" aria-hidden="true" />
              até {formatDateTime(plan.expires_at)}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Proveniência</p>
            {plan.input_provenance.kind === "adapter" ? (
              <p className="mt-1 break-all text-sm">
                adapter <code>{plan.input_provenance.adapter_id}</code> · input {plan.input_provenance.adapter_input_hash}
              </p>
            ) : (
              <p className="mt-1 text-sm">invocation JSON enviada diretamente</p>
            )}
          </div>
        </div>

        <div className="rounded-lg border p-3">
          <p className="text-xs font-medium text-muted-foreground">Repository resolvido</p>
          {plan.repository_id === undefined ? (
            <p className="mt-1 text-sm">
              {plan.repository_required
                ? "Obrigatório, mas não resolvido — o contrato teria rejeitado este plano."
                : "Este workflow não exige repository."}
            </p>
          ) : (
            <div className="mt-2 space-y-1 text-sm">
              <p><code>{plan.repository_id}</code></p>
              <p className="break-all font-mono text-xs text-muted-foreground">{plan.repository_fingerprint}</p>
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          A configuração relevante não é devolvida ao navegador; o hash acima prende exatamente os valores privados usados no plano.
        </p>
      </CardContent>
    </Card>
  )
}

function Effects({ plan }: { plan: RunPlan }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Efeitos e incertezas</CardTitle>
        <CardDescription>
          Potencial é o que as registrations e policies permitem; resolvido é o que o preflight conseguiu determinar. Isso não é o ledger do que de fato ocorreu.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <EffectList title="Potenciais / declarados" effects={plan.potential_effects} />
        <EffectList title="Resolvidos no preflight" effects={plan.resolved_effects} />

        <section aria-labelledby="run-plan-uncertainties">
          <h3 id="run-plan-uncertainties" className="text-sm font-semibold">Incertezas</h3>
          {plan.effect_uncertainties.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Nenhuma incerteza adicional foi projetada.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {plan.effect_uncertainties.map((uncertainty) => (
                <li key={uncertainty.uncertainty_id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{uncertainty.kind}</span>
                    {uncertainty.may_include_unlisted_write && (
                      <Badge variant="destructive">pode incluir write não listado</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-muted-foreground">{uncertainty.description}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="run-plan-warnings">
          <h3 id="run-plan-warnings" className="text-sm font-semibold">Warnings</h3>
          {plan.warnings.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Nenhum warning adicional.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {plan.warnings.map((warning) => (
                <li key={warning.code} className="flex gap-2 rounded-lg border p-3 text-sm">
                  <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
                  <span><strong>{warning.code}:</strong> {warning.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  )
}

type Effect = RunPlan["potential_effects"][number] | RunPlan["resolved_effects"][number]

function EffectList({ title, effects }: { title: string; effects: readonly Effect[] }) {
  return (
    <section aria-label={title}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {effects.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nenhum efeito nesta camada.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {effects.map((effect) => (
            <li key={effect.effect_id} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{effect.category}</span>
                {effect.confirmation_required && <Badge variant="destructive">confirmação obrigatória</Badge>}
                {"resolution_source" in effect && <Badge variant="outline">{effect.resolution_source}</Badge>}
              </div>
              <p className="mt-1 text-muted-foreground">{effect.description}</p>
              {effect.operation_id !== undefined && (
                <p className="mt-1 break-all font-mono text-xs">{effect.operation_id}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Confirmation(props: ConfirmationProps) {
  const executable =
    props.canMutate &&
    !props.expired &&
    !props.executing &&
    !props.acceptanceUnknown &&
    props.realRunConfirmed &&
    props.listedEffectsConfirmed

  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirmação do run real</CardTitle>
        <CardDescription>
          Validate/Compile não são safe test. Este botão envia o plano para a fila real do runtime local.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.expired && (
          <Alert variant="destructive">
            <Clock3Icon aria-hidden="true" />
            <AlertTitle>Plano expirado</AlertTitle>
            <AlertDescription>Gere outro plano para recalcular hashes, efeitos e configuração instalada.</AlertDescription>
          </Alert>
        )}

        <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={props.realRunConfirmed}
            onChange={(event) => props.onRealRunConfirmedChange(event.target.checked)}
          />
          <span>
            <strong>Confirmo um run real.</strong>
            <span className="mt-1 block text-muted-foreground">Ele pode chamar modelos, processos, providers e modificar repository conforme o plano.</span>
          </span>
        </label>

        <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={props.listedEffectsConfirmed}
            onChange={(event) => props.onListedEffectsConfirmedChange(event.target.checked)}
          />
          <span>
            <strong>Li os efeitos listados e as incertezas.</strong>
            <span className="mt-1 block text-muted-foreground">Entendo que tools dinâmicas e branches podem impedir uma projeção completa antes do runtime.</span>
          </span>
        </label>

        <Button className="w-full" disabled={!executable} onClick={props.onExecute}>
          <PlayIcon aria-hidden="true" />
          {props.executing ? "Enviando para a fila…" : "Executar run real"}
        </Button>
      </CardContent>
    </Card>
  )
}

export function RunLaunchNoticeAlert({ notice }: { notice: RunLaunchNotice }) {
  return (
    <Alert variant={notice.kind === "acceptance_unknown" || notice.kind === "blocked" ? "default" : "destructive"}>
      {notice.kind === "acceptance_unknown" ? <ShieldAlertIcon aria-hidden="true" /> : <CircleAlertIcon aria-hidden="true" />}
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>
        <p>{notice.message}</p>
        {notice.requestId !== undefined && <p>Request ID: <code>{notice.requestId}</code></p>}
        {notice.planId !== undefined && <p>Plan ID: <code>{notice.planId}</code></p>}
        {notice.kind === "acceptance_unknown" && (
          <Link
            className={buttonVariants({ variant: "outline", size: "sm", className: "mt-3" })}
            to={notice.planId === undefined
              ? "/runs"
              : `/runs?plan_id=${encodeURIComponent(notice.planId)}`}
          >
            Consultar Runs <ExternalLinkIcon aria-hidden="true" />
          </Link>
        )}
      </AlertDescription>
    </Alert>
  )
}

export function RunPlanPanel(props: ConfirmationProps & { notice?: RunLaunchNotice }) {
  return (
    <div className="space-y-4" aria-live="polite">
      {props.notice !== undefined && <RunLaunchNoticeAlert notice={props.notice} />}
      <PlanIdentity plan={props.plan} />
      <Effects plan={props.plan} />
      <Confirmation {...props} />
    </div>
  )
}
