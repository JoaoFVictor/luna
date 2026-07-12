import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { studioApi } from "@/api/client"
import { studioKeys } from "@/api/queries"
import { studioResponseContracts } from "@/api/response-contracts"

export type RunEventStreamStatus =
  | "idle"
  | "waiting"
  | "connecting"
  | "live"
  | "reconnecting"
  | "complete"
  | "invalid"
  | "unsupported"

type StreamAnchor = {
  runId: string
  afterSequence: number
}

type UseRunEventStreamOptions = {
  runId: string
  afterSequence?: number
  enabled: boolean
}

function parseEventData<T>(
  data: string,
  contract: { parse(value: unknown): T },
): T | undefined {
  try {
    return contract.parse(JSON.parse(data))
  } catch {
    return undefined
  }
}

export function useRunEventStream({
  runId,
  afterSequence,
  enabled,
}: UseRunEventStreamOptions): RunEventStreamStatus {
  const queryClient = useQueryClient()
  const [anchor, setAnchor] = useState<StreamAnchor>()
  const [status, setStatus] = useState<RunEventStreamStatus>("idle")

  useEffect(() => {
    if (!enabled) {
      setAnchor(undefined)
      setStatus("idle")
      return
    }
    if (afterSequence === undefined) {
      setStatus("waiting")
      return
    }
    setAnchor((current) =>
      current?.runId === runId
        ? current
        : { runId, afterSequence },
    )
  }, [afterSequence, enabled, runId])

  useEffect(() => {
    if (!enabled || anchor?.runId !== runId) return
    if (typeof EventSource === "undefined") {
      setStatus("unsupported")
      return
    }

    let lastSequence = anchor.afterSequence
    let invalidationTimer: number | undefined
    let closed = false
    const invalidate = () => {
      invalidationTimer = undefined
      void queryClient.invalidateQueries({
        queryKey: studioKeys.run(runId),
        exact: true,
      })
      void queryClient.invalidateQueries({
        queryKey: studioKeys.timeline(runId),
        exact: true,
      })
      void queryClient.invalidateQueries({
        queryKey: studioKeys.runGraph(runId),
        exact: true,
      })
      void queryClient.invalidateQueries({
        queryKey: studioKeys.artifacts(runId),
        exact: true,
      })
      void queryClient.invalidateQueries({ queryKey: studioKeys.runs })
    }
    const flushInvalidations = () => {
      if (invalidationTimer !== undefined) {
        window.clearTimeout(invalidationTimer)
      }
      invalidate()
    }
    const scheduleInvalidation = () => {
      if (invalidationTimer !== undefined) return
      invalidationTimer = window.setTimeout(invalidate, 150)
    }
    const source = new EventSource(
      studioApi.runEventStreamUrl(runId, anchor.afterSequence),
    )

    const rejectStream = () => {
      if (closed) return
      closed = true
      source.close()
      setStatus("invalid")
      flushInvalidations()
    }
    const onRunEvent = (message: Event) => {
      if (!(message instanceof MessageEvent)) {
        rejectStream()
        return
      }
      const event = parseEventData(
        message.data,
        studioResponseContracts.runEvent,
      )
      if (event === undefined || event.run_id !== runId) {
        rejectStream()
        return
      }
      if (event.sequence <= lastSequence) return
      if (event.sequence !== lastSequence + 1) {
        rejectStream()
        return
      }
      lastSequence = event.sequence
      scheduleInvalidation()
    }
    const onComplete = (message: Event) => {
      if (!(message instanceof MessageEvent)) {
        rejectStream()
        return
      }
      const complete = parseEventData(
        message.data,
        studioResponseContracts.runEventStreamComplete,
      )
      if (complete === undefined || complete.run_id !== runId) {
        rejectStream()
        return
      }
      closed = true
      source.close()
      setStatus("complete")
      flushInvalidations()
    }

    setStatus("connecting")
    source.addEventListener("run-event", onRunEvent)
    source.addEventListener("stream-complete", onComplete)
    source.onopen = () => setStatus("live")
    source.onerror = () => {
      if (!closed) setStatus("reconnecting")
    }

    return () => {
      closed = true
      source.close()
      source.removeEventListener("run-event", onRunEvent)
      source.removeEventListener("stream-complete", onComplete)
      if (invalidationTimer !== undefined) {
        window.clearTimeout(invalidationTimer)
        invalidate()
      }
    }
  }, [anchor, enabled, queryClient, runId])

  return status
}
