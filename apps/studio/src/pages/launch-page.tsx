import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { RouteIcon } from "lucide-react"
import { useSearchParams } from "react-router-dom"

import { studioApi } from "@/api/client"
import { inputAdaptersQuery } from "@/api/queries"
import type { AdapterRoutingPreview } from "@/api/types"
import { useStudioSession } from "@/app/studio-context"
import { PageHeader } from "@/components/page-header"
import { PageError, PageLoading } from "@/components/page-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AdapterRoutingPreviewPanel } from "@/features/launch/adapter-routing-preview"
import { LaunchInputCard } from "@/features/launch/launch-input-card"
import {
  buildRunPlanInput,
  DEFAULT_INVOCATION_JSON,
  type LaunchInputMode,
} from "@/features/launch/launch-input"
import {
  RunLaunchNoticeAlert,
  RunPlanPanel,
} from "@/features/launch/run-plan-panel"
import { useRunLaunch } from "@/features/launch/use-run-launch"

type PreviewRequest = {
  adapterId: string
  input: string
  acknowledgedEffects: string[]
  generation: number
  controller: AbortController
}

export function LaunchPage() {
  const [params] = useSearchParams()
  const session = useStudioSession()
  const adapters = useQuery(inputAdaptersQuery)
  const launch = useRunLaunch()
  const invalidateRunLaunch = launch.invalidate
  const [inputMode, setInputMode] = useState<LaunchInputMode>("adapter")
  const [adapterId, setAdapterId] = useState("")
  const [opaqueInput, setOpaqueInput] = useState("")
  const [invocationJson, setInvocationJson] = useState(DEFAULT_INVOCATION_JSON)
  const [inputError, setInputError] = useState<string>()
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [previewResult, setPreviewResult] = useState<AdapterRoutingPreview>()
  const previewGeneration = useRef(0)
  const activePreview = useRef<AbortController | undefined>(undefined)
  const expectedWorkflow = params.get("workflow") ?? ""

  useEffect(() => {
    if (adapterId === "" && adapters.data?.adapters[0] !== undefined) {
      setAdapterId(adapters.data.adapters[0].id)
    }
  }, [adapterId, adapters.data])

  const selectedAdapter = adapters.data?.adapters.find(
    (adapter) => adapter.id === adapterId,
  )
  const requiredPreviewEffects = selectedAdapter?.preview.enabled
    ? selectedAdapter.preview.effects
    : []
  const previewEffectsAcknowledged = requiredPreviewEffects.every((effect) =>
    acknowledged.includes(effect),
  )

  const discardPreview = useCallback(() => {
    previewGeneration.current += 1
    activePreview.current?.abort()
    activePreview.current = undefined
    setPreviewResult(undefined)
  }, [])

  const invalidateInput = useCallback(() => {
    setInputError(undefined)
    discardPreview()
    invalidateRunLaunch()
  }, [discardPreview, invalidateRunLaunch])

  useEffect(() => () => activePreview.current?.abort(), [])

  useEffect(() => {
    setAcknowledged([])
    invalidateInput()
  }, [adapterId, invalidateInput])

  const preview = useMutation({
    mutationFn: async (request: PreviewRequest) =>
      await studioApi.previewInputRoute(
        request.adapterId,
        request.input,
        request.acknowledgedEffects,
        request.controller.signal,
      ),
    onSuccess: (next, request) => {
      if (request.generation === previewGeneration.current) setPreviewResult(next)
    },
    onError: (error, request) => {
      if (request.generation !== previewGeneration.current) return
      if (error instanceof DOMException && error.name === "AbortError") return
      setInputError(
        error instanceof Error ? error.message : "O preview do adapter falhou.",
      )
    },
    onSettled: (_result, _error, request) => {
      if (activePreview.current === request.controller) activePreview.current = undefined
    },
  })

  const requestPreview = () => {
    if (
      adapterId.length === 0 ||
      opaqueInput.trim().length === 0 ||
      !previewEffectsAcknowledged
    ) {
      return
    }
    activePreview.current?.abort()
    const controller = new AbortController()
    activePreview.current = controller
    const generation = previewGeneration.current + 1
    previewGeneration.current = generation
    setInputError(undefined)
    preview.mutate({
      adapterId,
      input: opaqueInput,
      acknowledgedEffects: [...acknowledged],
      generation,
      controller,
    })
  }

  const createPlan = (event: FormEvent) => {
    event.preventDefault()
    const built = buildRunPlanInput({
      mode: inputMode,
      adapterId,
      opaqueInput,
      invocationJson,
      acknowledgedAdapterEffects: acknowledged,
    })
    if (!built.success) {
      launch.invalidate()
      setInputError(built.message)
      return
    }
    setInputError(undefined)
    launch.plan(built.input)
  }

  const changeMode = (value: string) => {
    if (value !== "adapter" && value !== "invocation") return
    setInputMode(value)
    setInputError(undefined)
    discardPreview()
    launch.invalidate()
  }

  if (adapters.isPending) {
    return <div className="p-6"><PageLoading label="Carregando launch" /></div>
  }
  if (adapters.isError) {
    return (
      <div className="p-6">
        <PageError error={adapters.error} retry={() => void adapters.refetch()} />
      </div>
    )
  }

  const acceptanceUnknown = launch.notice?.kind === "acceptance_unknown"

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Execução real"
        title="Launch"
        description="Envie uma string a um adapter registrado ou uma invocation JSON. Primeiro o backend gera um plano autoritativo; somente depois de duas confirmações explícitas ele aceita o run na fila."
      />

      <Alert>
        <RouteIcon aria-hidden="true" />
        <AlertTitle>Adapter, routing preview e execução são etapas distintas</AlertTitle>
        <AlertDescription>
          O adapter produz a invocation e o router first-match decide o workflow. O preview ajuda a explicar essa decisão, mas não substitui o plano revalidado no servidor.
        </AlertDescription>
      </Alert>

      <form onSubmit={createPlan} className="space-y-4">
        <LaunchInputCard
          adapters={adapters.data.adapters}
          mode={inputMode}
          adapterId={adapterId}
          opaqueInput={opaqueInput}
          invocationJson={invocationJson}
          acknowledgedAdapterEffects={acknowledged}
          canMutate={session.canMutate}
          planning={launch.planning}
          previewing={preview.isPending}
          executing={launch.executing}
          inputError={inputError}
          onModeChange={changeMode}
          onAdapterChange={setAdapterId}
          onOpaqueInputChange={(value) => {
            setOpaqueInput(value)
            invalidateInput()
          }}
          onInvocationJsonChange={(value) => {
            setInvocationJson(value)
            invalidateInput()
          }}
          onAdapterEffectChange={(effect, checked) => {
            setAcknowledged((current) =>
              checked
                ? [...current, effect]
                : current.filter((item) => item !== effect),
            )
            discardPreview()
          }}
          onPreview={requestPreview}
        />
      </form>

      {previewResult !== undefined && <AdapterRoutingPreviewPanel result={previewResult} />}

      {launch.prepared !== undefined && expectedWorkflow !== "" && (
        <Alert variant={launch.prepared.plan.workflow_id === expectedWorkflow ? "default" : "destructive"}>
          <RouteIcon aria-hidden="true" />
          <AlertTitle>
            {launch.prepared.plan.workflow_id === expectedWorkflow
              ? "O plano corresponde ao workflow esperado"
              : "O workflow esperado não corresponde ao routing autoritativo"}
          </AlertTitle>
          <AlertDescription>
            Esperado <code>{expectedWorkflow}</code>; o backend planejou <code>{launch.prepared.plan.workflow_id}</code>. Essa comparação nunca altera a rota.
          </AlertDescription>
        </Alert>
      )}

      {launch.prepared === undefined && launch.notice !== undefined && (
        <RunLaunchNoticeAlert notice={launch.notice} />
      )}

      {launch.prepared !== undefined && (
        <RunPlanPanel
          plan={launch.prepared.plan}
          canMutate={session.canMutate}
          expired={launch.expired}
          executing={launch.executing}
          acceptanceUnknown={acceptanceUnknown}
          realRunConfirmed={launch.realRunConfirmed}
          listedEffectsConfirmed={launch.listedEffectsConfirmed}
          onRealRunConfirmedChange={launch.setRealRunConfirmed}
          onListedEffectsConfirmedChange={launch.setListedEffectsConfirmed}
          onExecute={launch.execute}
          notice={launch.notice}
        />
      )}
    </div>
  )
}
