import type { RunEvent, RunEventPage } from "@/api/types"

export function flattenRunTimeline(
  pages: readonly RunEventPage[] | undefined,
): readonly RunEvent[] {
  const byId = new Map(
    (pages ?? [])
      .flatMap((page) => page.items)
      .map((event) => [event.event_id, event] as const),
  )
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence)
}
