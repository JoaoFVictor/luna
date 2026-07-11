import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import { studioKeys, workflowConfigurationQuery } from "@/api/queries"
import type { ConfigurationApplyPlan, ConfigurationDraft, JsonValue } from "@/api/types"

type PendingUpdate = { path: readonly string[]; value: JsonValue }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "A operação de configuração falhou."
}

function applyIdempotencyKey(draft: ConfigurationDraft, plan: Extract<ConfigurationApplyPlan, { status: "ready" }>): string {
  return `configuration:${draft.draft_id}:${plan.record_revision}:${plan.draft_hash}`
}

export function useWorkflowConfigurationController(workflowId: string, initialDraftId?: string) {
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
  const [pendingUpdates, setPendingUpdates] = useState<Record<string, PendingUpdate>>({})

  useEffect(() => {
    setDraft(undefined)
    setPlan(undefined)
    setConfirmApply(false)
    setPendingUpdates({})
  }, [initialDraftId, workflowId])
  useEffect(() => { if (initialDraft.data !== undefined) setDraft(initialDraft.data) }, [initialDraft.data])

  const createDraft = useMutation({
    mutationFn: () => studioApi.createConfigurationDraft(workflowId),
    onSuccess: (created) => { setDraft(created); setPlan(undefined); toast.success("Edição de configuração iniciada.") },
    onError: (error) => toast.error(errorMessage(error)),
  })
  const patchDraft = useMutation({
    mutationFn: async (updates: readonly PendingUpdate[]) => {
      if (draft === undefined) throw new Error("Comece a editar antes de salvar.")
      return await studioApi.patchConfigurationDraft(workflowId, draft.draft_id, draft.etag, updates.map((update) => ({ path: [...update.path], value: update.value })))
    },
    onSuccess: (updated) => { setDraft(updated); setPlan(undefined); setPendingUpdates({}) },
    onError: (error) => toast.error(errorMessage(error)),
  })
  const validateDraft = useMutation({
    mutationFn: async () => {
      if (draft === undefined) throw new Error("Comece a editar antes de verificar.")
      return await studioApi.validateConfigurationDraft(workflowId, draft.draft_id, draft.etag)
    },
    onSuccess: (result) => {
      setDraft(result.draft); setPlan(undefined)
      toast[result.validation.status === "valid" ? "success" : "error"](result.validation.status === "valid" ? "Configuração válida." : "A configuração ainda possui problemas.")
    },
    onError: (error) => toast.error(errorMessage(error)),
  })
  const planApply = useMutation({
    mutationFn: async () => {
      if (draft === undefined) throw new Error("Comece a editar antes de revisar.")
      return await studioApi.planConfigurationApply(workflowId, draft.draft_id)
    },
    onSuccess: setPlan,
    onError: (error) => toast.error(errorMessage(error)),
  })
  const applyDraft = useMutation({
    mutationFn: async () => {
      if (draft === undefined || plan?.status !== "ready") throw new Error("A revisão confirmada não está disponível.")
      return await studioApi.applyConfigurationDraft(workflowId, draft.draft_id, draft.etag, plan.plan_token, applyIdempotencyKey(draft, plan))
    },
    onSuccess: async () => {
      setConfirmApply(false); setDraft(undefined); setPlan(undefined)
      await queryClient.invalidateQueries({ queryKey: studioKeys.workflowConfiguration(workflowId) })
      toast.success("Configuração aplicada.")
    },
    onError: (error) => toast.error(errorMessage(error)),
  })
  const mutationPending = createDraft.isPending || patchDraft.isPending || validateDraft.isPending || planApply.isPending || applyDraft.isPending

  return {
    installed, initialDraft, draft, plan, confirmApply, setConfirmApply,
    pendingUpdates, setPendingUpdates, pendingUpdateList: Object.values(pendingUpdates),
    createDraft, patchDraft, validateDraft, planApply, applyDraft, mutationPending,
    configuration: draft?.configuration ?? installed.data,
  }
}
