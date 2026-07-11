import { useCallback, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { studioApi } from "@/api/client"
import { invalidateStudioAppliedResource } from "@/api/invalidation"
import type { ApplyPlan, ApplyResult, DraftItem } from "@/api/types"

export function useWorkflowApply({
  draftId,
  draft,
  refetchDraft,
}: {
  draftId: string
  draft: DraftItem | undefined
  refetchDraft: () => Promise<unknown>
}) {
  const queryClient = useQueryClient()
  const [plan, setPlan] = useState<ApplyPlan>()
  const [idempotencyKey, setIdempotencyKey] = useState<string>()
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<ApplyResult>()

  const resetPlan = useCallback(() => {
    setPlan(undefined)
    setIdempotencyKey(undefined)
    setOpen(false)
  }, [])

  const resetContentDerivedState = useCallback(() => {
    resetPlan()
    setResult(undefined)
  }, [resetPlan])

  const planMutation = useMutation({
    mutationFn: (_options: { openDialog: boolean }) => studioApi.planApply(draftId),
    onMutate: ({ openDialog }) => {
      setPlan(undefined)
      setIdempotencyKey(undefined)
      setOpen(openDialog)
    },
    onSuccess: (nextPlan) => {
      setPlan(nextPlan)
      setIdempotencyKey(
        nextPlan.status === "ready" ? crypto.randomUUID() : undefined,
      )
      if (nextPlan.status === "conflicted") {
        toast.error("Conflito externo detectado")
      }
    },
    onError: (error) => {
      setOpen(false)
      toast.error(error instanceof Error ? error.message : "Falha ao gerar plano")
    },
  })

  const applyMutation = useMutation({
    mutationFn: async () => {
      if (
        draft === undefined ||
        plan?.status !== "ready" ||
        idempotencyKey === undefined
      ) {
        throw new Error("O plano de apply não está pronto")
      }
      return await studioApi.applyDraft(
        draftId,
        draft.etag,
        plan.plan_token,
        idempotencyKey,
      )
    },
    onSuccess: async (nextResult) => {
      setResult(nextResult)
      resetPlan()
      if (draft?.primary_resource.kind === "workflow") {
        await invalidateStudioAppliedResource(
          queryClient,
          draft.primary_resource,
        )
      }
      await refetchDraft()
      toast.success("Change set aplicado ao projeto")
    },
    onError: (error) => toast.error(
      error instanceof Error ? error.message : "Apply falhou",
    ),
  })

  return {
    plan,
    open,
    setOpen,
    result,
    planning: planMutation.isPending,
    applying: applyMutation.isPending,
    resetPlan,
    resetContentDerivedState,
    planApply: (openDialog: boolean) => planMutation.mutate({ openDialog }),
    apply: () => applyMutation.mutate(),
  }
}
