import { useCallback, useEffect, useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"

import { studioApi } from "@/api/client"
import type { RunPlan, RunPlanInput } from "@/api/types"
import {
  newRunIdempotencyKey,
  runLaunchNotice,
  type RunLaunchNotice,
} from "@/features/launch/run-launch-state"

export type { RunLaunchNotice } from "@/features/launch/run-launch-state"

type PreparedPlan = {
  plan: RunPlan
  idempotencyKey: string
}

type PlanRequest = {
  input: RunPlanInput
  generation: number
  controller: AbortController
}

type RunLaunchState = {
  prepared: PreparedPlan | undefined
  notice: RunLaunchNotice | undefined
  expired: boolean
  realRunConfirmed: boolean
  listedEffectsConfirmed: boolean
}

const EMPTY_RUN_LAUNCH_STATE: RunLaunchState = {
  prepared: undefined,
  notice: undefined,
  expired: false,
  realRunConfirmed: false,
  listedEffectsConfirmed: false,
}

export function useRunLaunch() {
  const navigate = useNavigate()
  const generation = useRef(0)
  const activePlan = useRef<AbortController | undefined>(undefined)
  const [state, setState] = useState<RunLaunchState>(EMPTY_RUN_LAUNCH_STATE)

  const invalidate = useCallback(() => {
    generation.current += 1
    activePlan.current?.abort()
    activePlan.current = undefined
    setState(EMPTY_RUN_LAUNCH_STATE)
  }, [])

  useEffect(() => () => activePlan.current?.abort(), [])

  useEffect(() => {
    const expiresAt = state.prepared?.plan.expires_at
    if (expiresAt === undefined) return
    const remaining = Date.parse(expiresAt) - Date.now()
    if (remaining <= 0) {
      setState((current) => ({ ...current, expired: true }))
      return
    }
    const timeout = window.setTimeout(
      () => setState((current) => ({ ...current, expired: true })),
      Math.min(remaining, 2_147_483_647),
    )
    return () => window.clearTimeout(timeout)
  }, [state.prepared?.plan.expires_at])

  const planning = useMutation({
    mutationFn: async (request: PlanRequest) =>
      await studioApi.planRun(request.input, request.controller.signal),
    onSuccess: (plan, request) => {
      if (request.generation !== generation.current) return
      setState({
        prepared: {
          plan,
          idempotencyKey: newRunIdempotencyKey(plan.plan_id),
        },
        notice: undefined,
        expired: Date.parse(plan.expires_at) <= Date.now(),
        realRunConfirmed: false,
        listedEffectsConfirmed: false,
      })
    },
    onError: (error, request) => {
      if (request.generation !== generation.current) return
      if (error instanceof DOMException && error.name === "AbortError") return
      setState((current) => ({
        ...current,
        notice: runLaunchNotice(error, "plan"),
      }))
    },
    onSettled: (_result, _error, request) => {
      if (activePlan.current === request.controller) activePlan.current = undefined
    },
  })

  const execution = useMutation({
    mutationFn: async (current: PreparedPlan) =>
      await studioApi.executeRun(current.plan.plan_id, {
        confirmation_token: current.plan.confirmation_token,
        idempotency_key: current.idempotencyKey,
        confirmation: {
          kind: "local_explicit",
          real_run_confirmed: true,
          listed_effects_confirmed: true,
        },
      }),
    onSuccess: (receipt) => {
      void navigate(`/runs/${encodeURIComponent(receipt.run_id)}`)
    },
    onError: (error, current) => {
      const nextNotice = runLaunchNotice(
        error,
        "execute",
        current.plan.plan_id,
      )
      setState((current) =>
        nextNotice.kind === "replan" || nextNotice.kind === "blocked"
          ? { ...EMPTY_RUN_LAUNCH_STATE, notice: nextNotice }
          : { ...current, notice: nextNotice },
      )
    },
  })

  const plan = useCallback(
    (input: RunPlanInput) => {
      activePlan.current?.abort()
      const controller = new AbortController()
      activePlan.current = controller
      const nextGeneration = generation.current + 1
      generation.current = nextGeneration
      setState(EMPTY_RUN_LAUNCH_STATE)
      planning.mutate({ input, generation: nextGeneration, controller })
    },
    [planning],
  )

  const execute = useCallback(() => {
    if (
      state.prepared === undefined ||
      state.expired ||
      !state.realRunConfirmed ||
      !state.listedEffectsConfirmed ||
      state.notice?.kind === "acceptance_unknown" ||
      state.notice?.kind === "blocked"
    ) {
      return
    }
    execution.mutate(state.prepared)
  }, [
    execution,
    state.expired,
    state.listedEffectsConfirmed,
    state.notice?.kind,
    state.prepared,
    state.realRunConfirmed,
  ])

  return {
    plan,
    execute,
    invalidate,
    prepared: state.prepared,
    notice: state.notice,
    expired: state.expired,
    planning: planning.isPending,
    executing: execution.isPending,
    realRunConfirmed: state.realRunConfirmed,
    setRealRunConfirmed: (value: boolean) =>
      setState((current) => ({ ...current, realRunConfirmed: value })),
    listedEffectsConfirmed: state.listedEffectsConfirmed,
    setListedEffectsConfirmed: (value: boolean) =>
      setState((current) => ({ ...current, listedEffectsConfirmed: value })),
  }
}
