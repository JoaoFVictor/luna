import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { RunEvent } from "@/api/types"
import { RunTimelinePanel } from "@/features/runs/run-timeline-panel"

const event = (sequence: number, eventType: string): RunEvent => ({
  schema_version: 1,
  run_id: "run-timeline-test",
  sequence,
  event_id: `event-${sequence}`,
  event_type: eventType,
  occurred_at: "2026-07-12T12:00:00.000Z",
  data: null,
})

describe("RunTimelinePanel", () => {
  it("hides heartbeats until technical events are requested", () => {
    render(
      <RunTimelinePanel
        events={[event(1, "run.heartbeat"), event(2, "run.status.failed")]}
        streamStatus="complete"
        terminal
        pending={false}
        hasPrevious={false}
        fetchingPrevious={false}
        error={undefined}
        retry={() => undefined}
        fetchPrevious={() => undefined}
      />,
    )

    expect(screen.queryByText("Heartbeat")).toBeNull()
    expect(screen.getByText("Failed")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: /Mostrar 1 técnicos/ }))
    expect(screen.getByText("Heartbeat")).toBeDefined()
  })
})
