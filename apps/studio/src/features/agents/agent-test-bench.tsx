import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FlaskConicalIcon, RefreshCwIcon, ShieldAlertIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import {
  StudioAgentTestPlanRequestSchema,
  StudioAgentTestPlanSchema,
  StudioAgentTestResultSchema,
  type StudioAgentTestExecuteRequest,
  type StudioAgentTestModelProfile,
  type StudioAgentTestPlan,
  type StudioAgentTestPlanRequest,
  type StudioAgentTestResult,
  type StudioAgentTestTarget,
} from "../../../../../src/studio/contracts/agent-test-bench.js"
import { AgentTestBenchPreview } from "./agent-test-bench-preview"

export type AgentTestBenchProps = {
  target: StudioAgentTestTarget
  initialFixture?: Record<string, unknown>
  initialExplicitContext?: Record<string, unknown>
  disabled?: boolean
  plan: (
    request: StudioAgentTestPlanRequest,
    signal: AbortSignal,
  ) => Promise<StudioAgentTestPlan>
  execute: (
    planId: string,
    request: StudioAgentTestExecuteRequest,
    signal: AbortSignal,
  ) => Promise<StudioAgentTestResult>
}

type ParsedObject =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

function prettyJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2)
}

function parseJsonObject(source: string, label: string): ParsedObject {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return { ok: false, error: `${label} precisa ser JSON válido.` }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: `${label} precisa ser um objeto JSON.` }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Falha inesperada no Test Bench."
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError")
}

function targetLabel(target: StudioAgentTestTarget): string {
  return target.kind === "installed"
    ? `instalado · ${target.agent_id}`
    : `draft salvo · ${target.draft_id}`
}

export function AgentTestBench({
  target,
  initialFixture = {},
  initialExplicitContext = {},
  disabled = false,
  plan: requestPlan,
  execute: executePlan,
}: AgentTestBenchProps) {
  const [fixtureSource, setFixtureSource] = useState(() => prettyJson(initialFixture))
  const [includeExplicitContext, setIncludeExplicitContext] = useState(
    Object.keys(initialExplicitContext).length > 0,
  )
  const [contextSource, setContextSource] = useState(() =>
    prettyJson(initialExplicitContext),
  )
  const [selectedProfileId, setSelectedProfileId] = useState("")
  const [knownProfiles, setKnownProfiles] = useState<StudioAgentTestModelProfile[]>([])
  const [preview, setPreview] = useState<StudioAgentTestPlan>()
  const [result, setResult] = useState<StudioAgentTestResult>()
  const [error, setError] = useState<string>()
  const [planning, setPlanning] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [executionAttempted, setExecutionAttempted] = useState(false)
  const [realModelConfirmed, setRealModelConfirmed] = useState(false)
  const [smokeScopeConfirmed, setSmokeScopeConfirmed] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  const planAbort = useRef<AbortController | undefined>(undefined)
  const executeAbort = useRef<AbortController | undefined>(undefined)
  const targetKey = useMemo(() => JSON.stringify(target), [target])

  const resetConfirmation = useCallback(() => {
    setRealModelConfirmed(false)
    setSmokeScopeConfirmed(false)
    setExecutionAttempted(false)
  }, [])

  const invalidatePreview = useCallback((keepProfiles = true) => {
    planAbort.current?.abort()
    executeAbort.current?.abort()
    setPlanning(false)
    setExecuting(false)
    setPreview(undefined)
    setResult(undefined)
    setError(undefined)
    resetConfirmation()
    if (!keepProfiles) {
      setKnownProfiles([])
      setSelectedProfileId("")
    }
  }, [resetConfirmation])

  useEffect(() => {
    invalidatePreview(false)
  }, [invalidatePreview, targetKey])

  useEffect(() => () => {
    planAbort.current?.abort()
    executeAbort.current?.abort()
  }, [])

  useEffect(() => {
    if (preview === undefined) return
    setClock(Date.now())
    const interval = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [preview])

  const buildRequest = useCallback(():
    | { ok: true; request: StudioAgentTestPlanRequest }
    | { ok: false; error: string } => {
    const fixture = parseJsonObject(fixtureSource, "Fixture")
    if (!fixture.ok) return fixture
    const explicitContext = includeExplicitContext
      ? parseJsonObject(contextSource, "Contexto explícito")
      : undefined
    if (explicitContext !== undefined && !explicitContext.ok) {
      return explicitContext
    }
    const parsed = StudioAgentTestPlanRequestSchema.safeParse({
      target,
      fixture: fixture.value,
      context: explicitContext === undefined
        ? { kind: "none" }
        : { kind: "json", value: explicitContext.value },
      ...(selectedProfileId === ""
        ? {}
        : { model_profile_id: selectedProfileId }),
    })
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Entrada fora dos limites do Test Bench.",
      }
    }
    return { ok: true, request: parsed.data }
  }, [contextSource, fixtureSource, includeExplicitContext, selectedProfileId, target])

  const generatePreview = useCallback(async () => {
    const built = buildRequest()
    if (!built.ok) {
      setError(built.error)
      return
    }
    invalidatePreview(true)
    const controller = new AbortController()
    planAbort.current = controller
    setPlanning(true)
    try {
      const response = StudioAgentTestPlanSchema.parse(
        await requestPlan(built.request, controller.signal),
      )
      if (controller.signal.aborted) return
      setPreview(response)
      setKnownProfiles(response.resolution.available_model_profiles)
      setClock(Date.now())
    } catch (cause) {
      if (!isAbort(cause, controller.signal)) setError(errorMessage(cause))
    } finally {
      if (planAbort.current === controller) {
        planAbort.current = undefined
        setPlanning(false)
      }
    }
  }, [buildRequest, invalidatePreview, requestPlan])

  const execute = useCallback(async () => {
    if (disabled || preview?.execution.available !== true) return
    const controller = new AbortController()
    executeAbort.current = controller
    setExecuting(true)
    setExecutionAttempted(true)
    setError(undefined)
    setResult(undefined)
    const request: StudioAgentTestExecuteRequest = {
      confirmation_token: preview.execution.confirmation_token,
      confirmation: {
        kind: "local_explicit",
        real_model_call_confirmed: true,
        isolated_smoke_scope_confirmed: true,
      },
    }
    try {
      const response = StudioAgentTestResultSchema.parse(
        await executePlan(preview.plan_id, request, controller.signal),
      )
      if (!controller.signal.aborted) setResult(response)
    } catch (cause) {
      if (!isAbort(cause, controller.signal)) setError(errorMessage(cause))
    } finally {
      if (executeAbort.current === controller) {
        executeAbort.current = undefined
        setExecuting(false)
      }
    }
  }, [disabled, executePlan, preview])

  const expired = preview === undefined
    ? false
    : Date.parse(preview.expires_at) <= clock
  const inputDisabled = disabled || executing

  return (
    <section className="space-y-4" aria-labelledby="agent-test-bench-title">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle id="agent-test-bench-title" className="flex items-center gap-2">
                <FlaskConicalIcon className="size-5" aria-hidden="true" />
                Test Bench do agent
              </CardTitle>
              <CardDescription>
                Fixture limitada + contexto JSON explicitamente fornecido.
              </CardDescription>
            </div>
            <Badge variant="outline">{targetLabel(target)}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <Alert>
            <ShieldAlertIcon aria-hidden="true" />
            <AlertTitle>Isto faz uma chamada real ao modelo</AlertTitle>
            <AlertDescription>
              Primeiro gere o preview efetivo. A chamada só ocorre após duas confirmações explícitas; ela não executa workflow, tools, MCP ou subagents.
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <label htmlFor="agent-test-fixture" className="text-sm font-medium">
              Fixture JSON
            </label>
            <Textarea
              id="agent-test-fixture"
              className="min-h-40 font-mono text-xs"
              spellCheck={false}
              value={fixtureSource}
              disabled={inputDisabled}
              onChange={(event) => {
                setFixtureSource(event.target.value)
                invalidatePreview(true)
              }}
            />
            <p className="text-xs text-muted-foreground">
              Somente objeto JSON; limite aplicado pelo contrato do backend.
            </p>
          </div>

          <div className="space-y-3">
            <label className="flex items-center gap-3 text-sm font-medium">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                aria-label="Incluir contexto JSON explícito"
                checked={includeExplicitContext}
                disabled={inputDisabled}
                onChange={(event) => {
                  setIncludeExplicitContext(event.target.checked)
                  invalidatePreview(true)
                }}
              />
              Incluir contexto JSON explícito
            </label>
            {includeExplicitContext && (
              <div className="space-y-2">
                <label htmlFor="agent-test-context" className="text-sm font-medium">
                  Contexto explícito
                </label>
                <Textarea
                  id="agent-test-context"
                  className="min-h-32 font-mono text-xs"
                  spellCheck={false}
                  value={contextSource}
                  disabled={inputDisabled}
                  onChange={(event) => {
                    setContextSource(event.target.value)
                    invalidatePreview(true)
                  }}
                />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="agent-test-model-profile" className="text-sm font-medium">
              Model profile
            </label>
            <select
              id="agent-test-model-profile"
              className="flex h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm disabled:opacity-50 sm:max-w-md"
              value={selectedProfileId}
              disabled={inputDisabled || knownProfiles.length === 0}
              onChange={(event) => {
                setSelectedProfileId(event.target.value)
                invalidatePreview(true)
              }}
            >
              <option value="">Padrão declarado pelo agent</option>
              {knownProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.id} · {profile.model}
                </option>
              ))}
            </select>
            {knownProfiles.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Os profiles reais aparecem depois do primeiro preview.
              </p>
            )}
          </div>

          <Button
            variant={preview === undefined ? "default" : "outline"}
            disabled={disabled || planning || executing}
            onClick={() => void generatePreview()}
          >
            <RefreshCwIcon className={planning ? "animate-spin" : undefined} aria-hidden="true" />
            {planning ? "Resolvendo…" : preview === undefined ? "Gerar preview efetivo" : "Gerar novo preview"}
          </Button>
        </CardContent>
      </Card>

      {error !== undefined && (
        <Alert variant="destructive">
          <ShieldAlertIcon aria-hidden="true" />
          <AlertTitle>Test Bench não concluiu</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {preview !== undefined && (
        <AgentTestBenchPreview
          plan={preview}
          result={result}
          expired={expired}
          disabled={disabled}
          executing={executing}
          executionAttempted={executionAttempted}
          realModelConfirmed={realModelConfirmed}
          smokeScopeConfirmed={smokeScopeConfirmed}
          onRealModelConfirmedChange={setRealModelConfirmed}
          onSmokeScopeConfirmedChange={setSmokeScopeConfirmed}
          onExecute={() => void execute()}
        />
      )}
    </section>
  )
}
