import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { DatabaseIcon, RouteIcon } from "lucide-react"
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
import { formatCount } from "@/lib/presentation"

type PreviewRequest = {
  adapterId: string
  input: string
  acknowledgedEffects: string[]
  generation: number
  controller: AbortController
}

export function LaunchPage({
  expectedWorkflow: expectedWorkflowOverride,
  definitionSource = { kind: "installed" },
  executionScope = { kind: "workflow" },
  testData,
  embedded = false,
}: {
  expectedWorkflow?: string
  definitionSource?: RunPlanInput["definition_source"]
  executionScope?: RunPlanInput["execution_scope"]
  testData?: readonly { readonly fixtureName: string; readonly nodeId: string }[]
  embedded?: boolean
} = {}) {
  const [params] = useSearchParams()
  const session = useStudioSession()
  const queryClient = useQueryClient()
  const adapters = useQuery(inputAdaptersQuery)
  const testDataKey = testData?.map((entry) => entry.fixtureName).join("\u0000")
  const planRun = useCallback(
    async (input: RunPlanInput, signal?: AbortSignal) =>
      definitionSource.kind === "draft"
        ? await studioApi.planDraftTestRun(
            definitionSource.draft_id,
            {
              input,
              ...(testData === undefined || testData.length === 0
                ? {}
                : { test_data: testData.map((entry) => ({ fixture_name: entry.fixtureName })) }),
            },
            signal,
          )
        : await studioApi.planRun(input, signal),
    [
      definitionSource.kind,
      definitionSource.kind === "draft" ? definitionSource.draft_id : undefined,
      testData,
    ],
  )
  const launch = useRunLaunch(planRun)
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
  const definitionSourceKey = definitionSource.kind === "installed"
    ? "installed"
    : `${definitionSource.draft_id}:${definitionSource.etag}`

  useEffect(() => {
    setInputError(undefined)
    invalidateRunLaunch()
  }, [definitionSourceKey, invalidateRunLaunch, testDataKey])

  useEffect(() => {
    if (adapterId !== "") return
    const requested = adapters.data?.adapters.find((adapter) => adapter.id === requestedAdapter)
    if (requested !== undefined) {
      setAdapterId(requested.id)
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
      definitionSource,
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
      {executionScope.kind === "isolated_node" && (
        <Alert>
          <RouteIcon aria-hidden="true" />
          <AlertTitle>Teste isolado de {executionScope.node_id}</AlertTitle>
          <AlertDescription>
            Somente este passo será executado. Suas dependências precisam estar cobertas por dados salvos ativos.
          </AlertDescription>
        </Alert>
      )}
      {executionScope.kind === "from_node" && (
        <Alert>
          <RouteIcon aria-hidden="true" />
          <AlertTitle>Teste a partir de {executionScope.node_id}</AlertTitle>
          <AlertDescription>
            Este passo e seus descendentes serão executados. Entradas externas precisam estar cobertas por dados salvos ativos.
          </AlertDescription>
        </Alert>
      )}

      {definitionSource.kind === "draft" && (
        <Alert>
          <RouteIcon aria-hidden="true" />
          <AlertTitle>Testando o draft salvo</AlertTitle>
          <AlertDescription>
            Este teste usa exatamente a revisão salva no editor e não depende das regras de routing instaladas.
          </AlertDescription>
        </Alert>
      )}

      {testData !== undefined && testData.length > 0 && (
        <Alert>
          <DatabaseIcon aria-hidden="true" />
          <AlertTitle>
            {testData.length === 1
              ? "1 nó será substituído neste teste"
              : `${formatCount(testData.length, "nó", "nós")} serão substituídos neste teste`}
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {testData.map((entry) => (
                <li key={entry.nodeId}>
                  <code>{entry.nodeId}</code> usará <code>{entry.fixtureName}</code> e não executará.
                </li>
              ))}
            </ul>
            <p className="mt-2">A invocation abaixo continua sendo usada; nodes restantes e seus efeitos são reais. Produção ignora estes dados.</p>
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
          invocationRoutingDescription={definitionSource.kind === "draft"
            ? "Modo técnico para uma invocation já normalizada. Este draft salvo será executado diretamente."
            : "Modo técnico para uma invocation já normalizada. As regras instaladas decidem o workflow."}
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
            {launch.prepared.plan.workflow_id === expectedWorkflow
              ? definitionSource.kind === "draft"
                ? "A revisão salva deste draft foi preparada para execução."
                : "A primeira regra correspondente direcionou a entrada para este workflow."
              : <>Você abriu <code>{expectedWorkflow}</code>, mas a primeira regra correspondente escolheu <code>{launch.prepared.plan.workflow_id}</code>. Revise as regras de roteamento antes de continuar.</>}
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
