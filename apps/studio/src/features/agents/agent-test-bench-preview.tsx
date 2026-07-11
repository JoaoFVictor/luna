import {
  AlertTriangleIcon,
  Clock3Icon,
  CpuIcon,
  PlayIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { formatDateTime } from "@/lib/format"
import type {
  StudioAgentTestPlan,
  StudioAgentTestResult,
} from "../../../../../src/studio/contracts/agent-test-bench.js"
import { AgentTestBenchCapabilities } from "./agent-test-bench-capabilities"
import { AgentTestBenchResult } from "./agent-test-bench-result"
import {
  AgentTestBenchEmptyLine,
  AgentTestBenchExactValue,
} from "./agent-test-bench-values"

type PreviewProps = {
  plan: StudioAgentTestPlan
  result?: StudioAgentTestResult
  expired: boolean
  disabled: boolean
  executing: boolean
  executionAttempted: boolean
  realModelConfirmed: boolean
  smokeScopeConfirmed: boolean
  onRealModelConfirmedChange: (value: boolean) => void
  onSmokeScopeConfirmedChange: (value: boolean) => void
  onExecute: () => void
}

function Identity({ plan }: { plan: StudioAgentTestPlan }) {
  const { resolution } = plan
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Preview efetivo</CardTitle>
            <CardDescription>
              Snapshot revalidado imediatamente antes da chamada ao modelo.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{resolution.agent_mode}</Badge>
            <Badge variant={plan.execution.available ? "secondary" : "destructive"}>
              {plan.execution.available ? "pronto para confirmar" : "bloqueado"}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <ShieldCheckIcon aria-hidden="true" />
          <AlertTitle>Escopo deliberadamente limitado</AlertTitle>
          <AlertDescription>{resolution.scope.statement}</AlertDescription>
        </Alert>
        <dl className="grid gap-4 sm:grid-cols-2">
          <AgentTestBenchExactValue label="Agent" value={resolution.target.agent_id} />
          <AgentTestBenchExactValue label="Agent revision" value={resolution.target.agent_revision} />
          <AgentTestBenchExactValue label="Snapshot" value={plan.snapshot_hash} />
          <AgentTestBenchExactValue label="Fixture" value={plan.fixture_hash} />
          <AgentTestBenchExactValue label="Contexto explícito" value={plan.context_hash} />
          <AgentTestBenchExactValue label="Catálogo técnico" value={resolution.catalog_fingerprint} />
        </dl>
        <p className="flex items-center gap-2 text-sm">
          <Clock3Icon className="size-4" aria-hidden="true" />
          confirmação válida até {formatDateTime(plan.expires_at)}
        </p>
      </CardContent>
    </Card>
  )
}

function RuntimeAndModel({ plan }: { plan: StudioAgentTestPlan }) {
  const { resolution } = plan
  return (
    <Card>
      <CardHeader>
        <CardTitle>Runtime e modelo reais</CardTitle>
        <CardDescription>
          Apenas profiles carregados de models.yaml aparecem como selecionáveis.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <CpuIcon className="size-4" aria-hidden="true" />
          <strong>{resolution.runtime.display_name}</strong>
          <Badge variant="outline">{resolution.runtime.id}</Badge>
        </div>
        <dl className="grid gap-4 sm:grid-cols-2">
          <AgentTestBenchExactValue
            label="Profile selecionado"
            value={resolution.selected_model_profile.id}
          />
          <AgentTestBenchExactValue
            label="Modelo"
            value={[
              resolution.selected_model_profile.provider,
              resolution.selected_model_profile.model,
            ].filter(Boolean).join(" · ")}
          />
          <AgentTestBenchExactValue
            label="Runtime config"
            value={resolution.runtime.configuration_hash}
          />
          <AgentTestBenchExactValue
            label="Output schema"
            value={resolution.output_schema_hash}
          />
        </dl>
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            Requirements declarados e derivados
          </p>
          {resolution.runtime_requirements.length === 0 ? (
            <AgentTestBenchEmptyLine>Nenhum requirement.</AgentTestBenchEmptyLine>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-2">
              {resolution.runtime_requirements.map((requirement) => (
                <li key={requirement.id}>
                  <Badge variant={requirement.runtime_supported ? "secondary" : "destructive"}>
                    {requirement.id} · {requirement.required_for_smoke ? "exigido" : "excluído"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function Confirmation({
  plan,
  expired,
  disabled,
  executing,
  executionAttempted,
  realModelConfirmed,
  smokeScopeConfirmed,
  onRealModelConfirmedChange,
  onSmokeScopeConfirmedChange,
  onExecute,
}: Omit<PreviewProps, "result">) {
  if (!plan.execution.available) {
    return (
      <Alert variant="destructive">
        <AlertTriangleIcon aria-hidden="true" />
        <AlertTitle>Execução bloqueada</AlertTitle>
        <AlertDescription>
          <ul className="list-disc space-y-1 pl-5">
            {plan.execution.blockers.map((blocker) => (
              <li key={`${blocker.code}:${blocker.message}`}>
                <strong>{blocker.code}:</strong> {blocker.message}
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    )
  }

  const canExecute =
    !disabled &&
    !expired &&
    !executing &&
    !executionAttempted &&
    realModelConfirmed &&
    smokeScopeConfirmed

  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirmação da chamada real</CardTitle>
        <CardDescription>
          A confirmação é one-shot. Depois de clicar, um novo teste exige outro preview.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {expired && (
          <Alert variant="destructive">
            <Clock3Icon aria-hidden="true" />
            <AlertTitle>Preview expirado</AlertTitle>
            <AlertDescription>Gere outro preview antes de executar.</AlertDescription>
          </Alert>
        )}
        {executionAttempted && !executing && (
          <Alert>
            <AlertTriangleIcon aria-hidden="true" />
            <AlertTitle>Confirmação consumida</AlertTitle>
            <AlertDescription>
              Gere outro preview para uma nova tentativa; o backend não repete uma chamada cujo resultado possa ser desconhecido.
            </AlertDescription>
          </Alert>
        )}
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            aria-label="Confirmo uma chamada real ao modelo"
            checked={realModelConfirmed}
            disabled={disabled || expired || executing || executionAttempted}
            onChange={(event) => onRealModelConfirmedChange(event.target.checked)}
          />
          <span>
            Confirmo uma chamada real ao modelo configurado, com possível consumo e custo.
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            aria-label="Confirmo o escopo isolado do smoke"
            checked={smokeScopeConfirmed}
            disabled={disabled || expired || executing || executionAttempted}
            onChange={(event) => onSmokeScopeConfirmedChange(event.target.checked)}
          />
          <span>
            Entendi que tools, MCP, subagents e contextos implícitos não serão executados ou incluídos.
          </span>
        </label>
        <Button disabled={!canExecute} onClick={onExecute}>
          <PlayIcon aria-hidden="true" />
          {executing ? "Chamando modelo…" : "Executar smoke real"}
        </Button>
      </CardContent>
    </Card>
  )
}

export function AgentTestBenchPreview(props: PreviewProps) {
  return (
    <div className="space-y-4">
      <Identity plan={props.plan} />
      <RuntimeAndModel plan={props.plan} />
      <AgentTestBenchCapabilities plan={props.plan} />
      <Confirmation {...props} />
      {props.result !== undefined && <AgentTestBenchResult result={props.result} />}
    </div>
  )
}
