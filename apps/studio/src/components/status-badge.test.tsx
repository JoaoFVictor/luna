import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { RunStatusBadge } from "@/components/status-badge"
import { formatDuration } from "@/lib/format"

describe("historical run presentation", () => {
  it("shows status and duration as unavailable without inventing values", () => {
    render(<RunStatusBadge status="historical_unknown" />)

    expect(screen.getByText("Histórica · status indisponível")).toBeDefined()
    expect(formatDuration(undefined)).toBe("Indisponível")
  })
})
