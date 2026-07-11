import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CheckCircle2Icon,
  FileCheck2Icon,
  RefreshCwIcon,
  SaveIcon,
  ShieldAlertIcon,
} from "lucide-react"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import { studioKeys, workflowConfigurationQuery } from "@/api/queries"
import type {
  ConfigurationApplyPlan,
  ConfigurationDraft,
  JsonValue,
} from "@/api/types"
import { useStudioSession } from "@/app/studio-context"
import { PageError, PageLoading } from "@/components/page-state"
import { DraftStatusBadge } from "@/components/status-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ConfigurationFieldEditor } from "./configuration-field-editor"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "A operação de configuração falhou."
}

function fieldPath(path: readonly string[]): string {
  return path.join(".")
}

function projectedValue(present: boolean, value: JsonValue | undefined): string {
  return present ? JSON.stringify(value) : "ausente"
}

function applyIdempotencyKey(
  draft: ConfigurationDraft,
  plan: Extract<ConfigurationApplyPlan, { status: "ready" }>,
): string {
  return `configuration:${draft.draft_id}:${plan.record_revision}:${plan.draft_hash}`
}

export function WorkflowConfigurationPanel({
  workflowId,
  initialDraftId,
}: {
  workflowId: string
  initialDraftId?: string
}) {
  const session = useStudioSession()
  const queryClient = useQueryClient()
  const installed = useQuery(workflowConfigurationQuery(workflowId))
  const initialDraft = useQuery({
    queryKey: ["configuration", "workflow", workflowId, "draft", initialDraftId],
    queryFn: ({ signal }) => studioApi.configurationDraft(workflowId, initialDraftId ?? "", signal),
    enabled: initialDraftId !== undefined,
  })
  const [draft, setDraft] = useState<ConfigurationDraft>()
  const [plan, setPlan] = useState<ConfigurationApplyPlan>()
  const [confirmApply, setConfirmApply] = useState(false)

  useEffect(() => {
    setDraft(undefined)
    setPlan(undefined)
    setConfirmApply(false)
  }, [initialDraftId, workflowId])

  useEffect(() => {
    if (initialDraft.data !== undefined) setDraft(initialDraft.data)
  }, [initialDraft.data])

  const createDraft = useMutation({
    mutationFn: () => studioApi.createConfigurationDraft(workflowId),
    onSuccess: (created) => {
      setDraft(created)
      setPlan(undefined)
      toast.success("Draft privado de configuração criado.")
    },
    onError: (error) => toast.error(errorMessage(error)),
  })
  const patchDraft = useMutation({
    mutationFn: async (update: { path: readonly string[]; value: JsonValue }) => {
      if (draft === undefined) throw new Error("Crie um draft antes de editar.")
      return await studioApi.patchConfigurationDraft(
        workflowId,
        draft.draft_id,
        draft.etag,
        [{ path: [...update.path], value: update.value }],
      )
    },
    onSuccess: (updated) => {
      setDraft(updated)
      setPlan(undefined)
    },
    onError: (error) => toast.error(errorMessage(error)),
  })
  const validateDraft = useMutation({
    mutationFn: async () => {
      if (draft === undefined) throw new Error("Crie um draft antes de validar.")
      return await studioApi.validateConfigurationDraft(
        workflowId,
        draft.draft_id,
        draft.etag,
      )
    },
    onSuccess: (result) => {
      setDraft(result.draft)
      setPlan(undefined)
      if (result.validation.status === "valid") toast.success("Configuração validada.")
      else toast.error("A configuração ainda possui erros de validação.")
    },
    onError: (error) => toast.error(errorMessage(error)),
  })
  const planApply = useMutation({
    mutationFn: async () => {
      if (draft === undefined) throw new Error("Crie um draft antes de planejar.")
      return await studioApi.planConfigurationApply(workflowId, draft.draft_id)
    },
    onSuccess: (next) => setPlan(next),
    onError: (error) => toast.error(errorMessage(error)),
  })
  const applyDraft = useMutation({
    mutationFn: async () => {
      if (draft === undefined || plan?.status !== "ready") {
        throw new Error("O plano confirmado não está disponível.")
      }
      return await studioApi.applyConfigurationDraft(
        workflowId,
        draft.draft_id,
        draft.etag,
        plan.plan_token,
        applyIdempotencyKey(draft, plan),
      )
    },
    onSuccess: async () => {
      setConfirmApply(false)
      setDraft(undefined)
      setPlan(undefined)
      await queryClient.invalidateQueries({
        queryKey: studioKeys.workflowConfiguration(workflowId),
      })
      toast.success("Configuração aplicada à fonte canônica.")
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  if (installed.isPending) return <PageLoading label="Carregando configuração" />
  if (installed.isError) {
    return <PageError error={installed.error} retry={() => void installed.refetch()} />
  }
  if (initialDraftId !== undefined && initialDraft.isPending) {
    return <PageLoading label="Carregando draft de configuração" />
  }
  if (initialDraftId !== undefined && initialDraft.isError) {
    return <PageError error={initialDraft.error} retry={() => void initialDraft.refetch()} />
  }

  const configuration = draft?.configuration ?? installed.data
  const mutationPending =
    createDraft.isPending ||
    patchDraft.isPending ||
    validateDraft.isPending ||
    planApply.isPending ||
    applyDraft.isPending

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Config de {workflowId}</CardTitle>
                <CardDescription>
                  Form gerado do JSON Schema; nenhum campo é inferido por nome.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={configuration.status === "ready" ? "secondary" : "outline"}>
                  {configuration.status}
                </Badge>
                <Badge variant="outline">raw YAML desabilitado</Badge>
                {draft !== undefined && <DraftStatusBadge status={draft.status} />}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground">Classificados</p>
                <p className="mt-1 text-xl font-semibold">
                  {configuration.schema_summary.classified_field_count}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground">Não classificados</p>
                <p className="mt-1 text-xl font-semibold">
                  {configuration.schema_summary.unclassified_field_count}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground">Referências $.config</p>
                <p className="mt-1 text-xl font-semibold">{configuration.references.length}</p>
              </div>
            </div>

            {configuration.diagnostics.map((diagnostic, index) => (
              <Alert key={`${diagnostic.code}:${index}`} variant={diagnostic.severity === "error" ? "destructive" : "default"}>
                <ShieldAlertIcon aria-hidden="true" />
                <AlertTitle>{diagnostic.code}</AlertTitle>
                <AlertDescription>{diagnostic.message}</AlertDescription>
              </Alert>
            ))}

            {configuration.status === "not_declared" ? (
              <Alert>
                <AlertTitle>Este workflow não declara config</AlertTitle>
                <AlertDescription>
                  Adicione config.file e config.schema ao workflow antes de criar um draft de valores.
                </AlertDescription>
              </Alert>
            ) : configuration.fields.length === 0 ? (
              <Alert>
                <AlertTitle>Nenhum valor autorizado para o navegador</AlertTitle>
                <AlertDescription>
                  O schema existe, mas nenhum leaf possui metadata x-luna-studio válida. Os valores continuam somente no servidor.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-3">
                {configuration.fields.map((field) => (
                  <ConfigurationFieldEditor
                    key={field.expression}
                    field={field}
                    canMutate={session.canMutate && draft !== undefined}
                    pending={mutationPending}
                    onSave={(path, value) => patchDraft.mutate({ path, value })}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Draft e apply</CardTitle>
              <CardDescription>
                O YAML privado permanece no backend; a UI envia somente path e valor classificados.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {draft === undefined ? (
                <Button
                  className="w-full"
                  disabled={
                    !session.canMutate ||
                    configuration.status !== "ready" ||
                    createDraft.isPending
                  }
                  onClick={() => createDraft.mutate()}
                >
                  <SaveIcon aria-hidden="true" />
                  {createDraft.isPending ? "Criando…" : "Criar draft de config"}
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={mutationPending}
                    onClick={() => validateDraft.mutate()}
                  >
                    <FileCheck2Icon aria-hidden="true" />
                    {validateDraft.isPending ? "Validando…" : "Validar draft"}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={mutationPending || draft.status !== "valid"}
                    onClick={() => planApply.mutate()}
                  >
                    <RefreshCwIcon aria-hidden="true" />
                    {planApply.isPending ? "Calculando…" : "Planejar apply"}
                  </Button>
                </>
              )}
              {!session.canMutate && (
                <p className="text-xs text-muted-foreground">
                  Sessão read-only: reabra a URL de inicialização para editar.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Referências</CardTitle>
              <CardDescription>Expressions encontradas na definição do workflow.</CardDescription>
            </CardHeader>
            <CardContent>
              {configuration.references.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhuma referência encontrada.</p>
              ) : (
                <ul className="space-y-2">
                  {configuration.references.map((reference) => (
                    <li key={reference.expression}>
                      <code className="block overflow-x-auto rounded bg-muted px-2 py-1 text-xs">
                        {reference.expression}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {plan !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>Plano seguro de apply</CardTitle>
            <CardDescription>
              Somente valores classificados aparecem no diff. Diff textual e YAML privado não são enviados ao browser.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {plan.status === "conflicted" ? (
              <Alert variant="destructive">
                <ShieldAlertIcon aria-hidden="true" />
                <AlertTitle>A fonte mudou depois da criação do draft</AlertTitle>
                <AlertDescription>
                  Recrie o draft antes de aplicar. {plan.conflicts.length} conflito(s) detectado(s).
                </AlertDescription>
              </Alert>
            ) : plan.changes.length === 0 ? (
              <Alert>
                <AlertTitle>Nenhuma mudança classificada</AlertTitle>
                <AlertDescription>O draft não altera valores expostos pelo Studio.</AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-3">
                {plan.changes.map((change) => (
                  <div key={fieldPath(change.path)} className="rounded-lg border p-3 text-sm">
                    <code>{fieldPath(change.path)}</code>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <div className="rounded bg-muted p-2">
                        <span className="text-xs text-muted-foreground">Antes</span>
                        <pre className="mt-1 overflow-x-auto text-xs">
                          {projectedValue(change.before_present, change.before)}
                        </pre>
                      </div>
                      <div className="rounded bg-muted p-2">
                        <span className="text-xs text-muted-foreground">Depois</span>
                        <pre className="mt-1 overflow-x-auto text-xs">
                          {projectedValue(change.after_present, change.after)}
                        </pre>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {plan.status === "ready" && plan.changes.length > 0 && (
              <>
                <Separator />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    Token expira em {new Date(plan.expires_at).toLocaleString("pt-BR")}.
                  </p>
                  <Button
                    disabled={mutationPending || draft === undefined}
                    onClick={() => setConfirmApply(true)}
                  >
                    <CheckCircle2Icon aria-hidden="true" /> Confirmar apply
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmApply} onOpenChange={setConfirmApply}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Aplicar configuração de {workflowId}?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta operação grava somente o arquivo de config autorizado. Não faz commit, push ou reload remoto.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={applyDraft.isPending}
              onClick={() => applyDraft.mutate()}
            >
              {applyDraft.isPending ? "Aplicando…" : "Aplicar configuração"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
