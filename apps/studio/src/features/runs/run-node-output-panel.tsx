import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { BracesIcon, CopyIcon, DatabaseIcon, PinIcon, ShieldCheckIcon } from "lucide-react"
import { Link } from "react-router-dom"
import { toast } from "sonner"

import { useStudioSession } from "@/app/studio-context"
import { studioApi } from "@/api/client"
import { StudioApiError } from "@/api/client-core"
import { draftQuery, runNodeOutputQuery, studioKeys } from "@/api/queries"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { workflowExpressionFixtures } from "@/features/workflows/workflow-expression-fixtures"
import { workflowDraftTestDataHref } from "@/features/drafts/draft-route"
import { RunNodeOutputComparison } from "@/features/runs/run-node-output-comparison"

const unavailableCopy = {
  graph_unavailable: "O snapshot exato do grafo não está disponível para esta execução.",
  run_not_terminal: "Os dados ficam disponíveis quando a execução termina.",
  outcome_unavailable: "O resultado terminal não pôde ser lido com segurança.",
  output_not_recorded: "Este passo não produziu um output reutilizável.",
} as const

export function RunNodeOutputPanel({
  runId,
  nodeId,
  draftId,
}: {
  runId: string
  nodeId: string
  draftId?: string
}) {
  const [requested, setRequested] = useState(false)
  const [previewSaveOpen, setPreviewSaveOpen] = useState(false)
  const [fixtureName, setFixtureName] = useState(() =>
    `pinned-${nodeId.replace(/[^A-Za-z0-9._ -]/gu, "-").slice(0, 40)}`,
  )
  const [savedName, setSavedName] = useState<string>()
  const [saveError, setSaveError] = useState<string>()
  const session = useStudioSession()
  const queryClient = useQueryClient()
  const output = useQuery({
    ...runNodeOutputQuery(runId, nodeId),
    enabled: requested,
  })
  const availableResponse = output.data !== undefined && output.data.availability === "available"
    ? output.data
    : undefined
  const retainedOutput = availableResponse?.output
  const draft = useQuery({
    ...draftQuery(draftId ?? ""),
    enabled: previewSaveOpen && draftId !== undefined,
  })
  const savePreviewData = useMutation({
    mutationFn: async (name: string) => {
      if (
        draftId === undefined ||
        draft.data === undefined ||
        output.data?.availability !== "available"
      ) {
        throw new Error("O draft ou a identidade do output não está disponível")
      }
      return await studioApi.promoteRunNodeOutputFixture(
        draftId,
        draft.data.etag,
        {
          fixture_name: name,
          run_id: runId,
          node_id: nodeId,
          graph_hash: output.data.graph_hash,
          outcome_hash: output.data.outcome_hash,
        },
      )
    },
    onSuccess: (nextDraft, name) => {
      queryClient.setQueryData(studioKeys.draft(nextDraft.draft_id), nextDraft)
      void queryClient.invalidateQueries({ queryKey: studioKeys.drafts })
      setSavedName(name)
      setSaveError(undefined)
      toast.success("Dados de preview salvos no draft")
    },
    onError: (error) => {
      if (error instanceof StudioApiError && error.status === 412) {
        void queryClient.invalidateQueries({ queryKey: studioKeys.draft(draftId ?? "") })
        setSaveError("O draft mudou. Recarregamos a revisão; confira e salve novamente.")
        return
      }
      setSaveError(error instanceof Error ? error.message : "Não foi possível salvar os dados de preview")
    },
  })

  const submitPreviewData = () => {
    const name = fixtureName.trim()
    const exists = draft.data !== undefined && Object.hasOwn(
      workflowExpressionFixtures(draft.data.layout),
      name,
    )
    if (exists && !window.confirm(`Substituir os dados de preview “${name}”?`)) return
    setSaveError(undefined)
    savePreviewData.mutate(name)
  }

  const copyOutput = async (value: unknown) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
      toast.success("Dados seguros copiados para reutilização")
    } catch {
      toast.error("Não foi possível copiar os dados")
    }
  }

  return (
    <section className="space-y-3 rounded-lg border bg-muted/15 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="flex items-center gap-2 text-sm font-medium">
            <DatabaseIcon className="size-4" aria-hidden="true" />
            Dados para reutilizar
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Snapshot privado da run exata, limitado e redigido pelo servidor.
          </p>
        </div>
        {!requested && (
          <Button size="sm" variant="outline" onClick={() => setRequested(true)}>
            <BracesIcon aria-hidden="true" /> Carregar dados reais
          </Button>
        )}
      </div>

      {output.isPending && requested && (
        <p className="text-sm text-muted-foreground" role="status">
          Carregando o snapshot autorizado…
        </p>
      )}
      {output.isError && (
        <div className="space-y-2">
          <Alert variant="destructive">
            <AlertTitle>Não foi possível carregar os dados</AlertTitle>
            <AlertDescription>{output.error.message}</AlertDescription>
          </Alert>
          <Button size="sm" variant="outline" onClick={() => void output.refetch()}>
            Tentar novamente
          </Button>
        </div>
      )}
      {output.data?.availability === "unavailable" && (
        <div className="space-y-2">
          <Alert>
            <AlertTitle>Output indisponível</AlertTitle>
            <AlertDescription>{unavailableCopy[output.data.reason]}</AlertDescription>
          </Alert>
          <Button size="sm" variant="outline" onClick={() => void output.refetch()}>
            Tentar novamente
          </Button>
        </div>
      )}
      {retainedOutput?.availability === "unavailable" && (
        <Alert>
          <AlertTitle>
            {retainedOutput.reason === "value_limit_exceeded"
              ? "Output maior que o limite seguro"
              : "Limite de snapshots da execução atingido"}
          </AlertTitle>
          <AlertDescription>
            O servidor preservou a execução, mas não reteve este valor para reutilização.
          </AlertDescription>
        </Alert>
      )}
      {retainedOutput?.availability === "available" && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
              {retainedOutput.redaction.changed
                ? "Segredos detectados foram removidos."
                : "Nenhum segredo conhecido foi detectado."}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void copyOutput(retainedOutput.value)}
            >
              <CopyIcon aria-hidden="true" /> Copiar JSON
            </Button>
            {draftId !== undefined && (
              <Button
                size="sm"
                variant="outline"
                disabled={!session.canMutate}
                aria-expanded={previewSaveOpen}
                aria-controls={`run-output-preview-data-${nodeId}`}
                onClick={() => setPreviewSaveOpen((current) => !current)}
              >
                <PinIcon aria-hidden="true" /> Salvar para preview
              </Button>
            )}
          </div>
          <pre className="max-h-72 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-all rounded-md border bg-background p-3 text-xs">
            {JSON.stringify(retainedOutput.value, null, 2)}
          </pre>
          {previewSaveOpen && draftId !== undefined && (
            <div id={`run-output-preview-data-${nodeId}`} className="space-y-3 rounded-md border bg-background p-3">
              <Field>
                <FieldLabel htmlFor={`run-output-fixture-${nodeId}`}>
                  Nome dos dados de preview
                </FieldLabel>
                <Input
                  id={`run-output-fixture-${nodeId}`}
                  value={fixtureName}
                  maxLength={64}
                  disabled={savePreviewData.isPending}
                  onChange={(event) => {
                    setFixtureName(event.target.value)
                    setSavedName(undefined)
                  }}
                />
                <FieldDescription>
                  O servidor copiará o snapshot redigido para previews de expressão. O YAML e as execuções não mudam.
                </FieldDescription>
              </Field>
              {draft.isPending && <p className="text-sm text-muted-foreground" role="status">Carregando o draft exato…</p>}
              {draft.isError && <p className="text-sm text-destructive">{draft.error.message}</p>}
              {saveError !== undefined && <p className="text-sm text-destructive" role="alert">{saveError}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={draft.data === undefined || savePreviewData.isPending || fixtureName.trim().length === 0}
                  onClick={submitPreviewData}
                >
                  <PinIcon aria-hidden="true" /> {savePreviewData.isPending ? "Salvando…" : "Salvar dados para preview"}
                </Button>
                {savedName !== undefined && (
                  <Link
                    className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                    to={workflowDraftTestDataHref(draftId, { fixtureName: savedName, nodeId })}
                  >
                    Abrir “{savedName}” no editor
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {availableResponse !== undefined && (
        <RunNodeOutputComparison
          runId={runId}
          nodeId={nodeId}
          workflowId={availableResponse.run.workflow_id}
        />
      )}
    </section>
  )
}
