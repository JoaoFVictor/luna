import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import { invalidateStudioAppliedResource } from "@/api/invalidation"
import { studioKeys } from "@/api/queries"
import type { ApplyPlan, ApplyResult, DraftItem } from "@/api/types"

export function useAgentApplyActions({ draftId, draft, refetchDraft }: {
  draftId: string
  draft: DraftItem | undefined
  refetchDraft: () => Promise<unknown>
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [plan, setPlan] = useState<ApplyPlan>()
  const [planOpen, setPlanOpen] = useState(false)
  const [applyKey, setApplyKey] = useState<string>()
  const [applyResult, setApplyResult] = useState<ApplyResult>()

  const planApply = useMutation({
    mutationFn: () => studioApi.planApply(draftId),
    onMutate: () => { setPlan(undefined); setApplyKey(undefined); setPlanOpen(true) },
    onSuccess: (next) => { setPlan(next); setApplyKey(next.status === "ready" ? crypto.randomUUID() : undefined) },
    onError: (error) => { setPlanOpen(false); toast.error(error instanceof Error ? error.message : "Falha ao preparar aplicação") },
  })
  const apply = useMutation({
    mutationFn: () => {
      if (draft === undefined || plan?.status !== "ready" || applyKey === undefined) throw new Error("O plano de aplicação não está pronto")
      return studioApi.applyDraft(draftId, draft.etag, plan.plan_token, applyKey)
    },
    onSuccess: async (result) => {
      setApplyResult(result)
      setPlanOpen(false)
      setPlan(undefined)
      if (draft?.primary_resource.kind === "agent") await invalidateStudioAppliedResource(queryClient, draft.primary_resource)
      await refetchDraft()
      toast.success("Agent aplicado ao projeto; nenhum commit ou push foi criado")
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Aplicação falhou"),
  })
  const remove = useMutation({
    mutationFn: async () => {
      if (draft === undefined) throw new Error("Draft indisponível")
      await studioApi.deleteDraft(draftId, draft.etag)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: studioKeys.drafts })
      void navigate("/agents")
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Falha ao remover draft"),
  })
  return { plan, setPlan, planOpen, setPlanOpen, applyResult, setApplyResult, planApply, apply, remove }
}
