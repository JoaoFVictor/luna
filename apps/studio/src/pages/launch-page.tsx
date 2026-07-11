import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RouteIcon } from "lucide-react"
import { useSearchParams } from "react-router-dom"

import { studioApi } from "@/api/client"
import { inputAdaptersQuery, studioKeys } from "@/api/queries"
import type { AdapterRoutingPreview, RunPlanInput } from "@/api/types"
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

export function LaunchPage({
  expectedWorkflow: expectedWorkflowOverride,
  executionScope = { kind: "workflow" },
  embedded = false,
}: {
  expectedWorkflow?: string
  executionScope?: RunPlanInput["execution_scope"]
  embedded?: boolean
} = {}) {
  const [params] = useSearchParams()
  const session = useStudioSession()
  const queryClient = useQueryClient()
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
  const expectedWorkflow = expectedWorkflowOverride ?? params.get("workflow") ?? ""
  const requestedAdapter = params.get("adapter") ?? ""

  useEffect(() => {
    if (adapterId !== "") return
    const requested = adapters.data?.adapters.find((adapter) => adapter.id === requestedAdapter)
    if (requested !== undefined) {
      setAdapterId(requested.id)
    } else if (adapters.data?.adapters[0] !== undefined) {
      setAdapterId(adapters.data.adapters[0].id)
    }
  }, [adapterId, adapters.data, requestedAdapter])

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
      void queryClient.invalidateQueries({ queryKey: studioKeys.configurationProviders })
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
      executionScope,
      adapterId,
      opaqueInput,
      invocationJson,
      acknowledgedAdapterEffects: acknowledged,
    })
    if (built.success === false) {
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
    <div className={embedded
      ? "mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pb-6"
      : "mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6"}
    >
      {!embedded && (
        <PageHeader
          eyebrow="Workflow"
          title={expectedWorkflow === "" ? "Executar workflow" : `Testar ${expectedWorkflow}`}
          description="Escolha uma entrada, confira o workflow selecionado e revise os efeitos antes de executar."
        />
      )}

      {executionScope.kind === "through_node" && (
        <Alert>
          <RouteIcon aria-hidden="true" />
          <AlertTitle>Teste parcial até {executionScope.node_id}</AlertTitle>
          <AlertDescription>
            Serão executados somente este passo e todas as dependências anteriores dele.
          </AlertDescription>
        </Alert>
      )}

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
              ? "Entrada pronta para este workflow"
              : "Esta entrada foi direcionada para outro workflow"}
          </AlertTitle>
          <AlertDescription>
            Você abriu <code>{expectedWorkflow}</code>, mas a primeira regra correspondente escolheu <code>{launch.prepared.plan.workflow_id}</code>. Revise as regras de routing antes de continuar.
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
