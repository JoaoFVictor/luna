import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PropsWithChildren } from "react"

import { studioApi } from "@/api/client"
import { RunNodeOutputComparison } from "@/features/runs/run-node-output-comparison"

const DIGEST = `sha256:${"a".repeat(64)}`

function wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

afterEach(() => vi.restoreAllMocks())

describe("RunNodeOutputComparison", () => {
  it("loads candidates and values only after explicit actions", async () => {
    const list = vi.spyOn(studioApi, "runCatalogPage").mockResolvedValue({
      items: [{
        run_id: "run-before",
        workflow_id: "code-review",
        workflow_revision: DIGEST,
        execution_snapshot_hash: DIGEST,
        dispatch_status: "started",
        run_status: "succeeded",
        status: "succeeded",
        created_at: "2026-07-10T10:00:00.000Z",
        started_at: "2026-07-10T10:00:01.000Z",
        finished_at: "2026-07-10T10:00:02.000Z",
        artifact_count: 0,
        interrupt_count: 0,
        completeness: "complete",
        wall_duration_ms: 1_000,
      }],
      next_cursor: null,
      as_of: "2026-07-10T10:00:03.000Z",
    })
    const compare = vi.spyOn(studioApi, "compareRunNodeOutput").mockResolvedValue({
      schema_version: 1,
      availability: "comparable",
      workflow_id: "code-review",
      node_id: "review",
      baseline: {
        run: {
          run_id: "run-before",
          workflow_id: "code-review",
          workflow_revision: DIGEST,
          definition_bundle_hash: DIGEST,
          execution_snapshot_hash: DIGEST,
          status: "succeeded",
          completeness: "complete",
        },
        graph_hash: DIGEST,
        outcome_hash: DIGEST,
        redaction_changed: false,
      },
      current: {
        run: {
          run_id: "run-current",
          workflow_id: "code-review",
          workflow_revision: `sha256:${"b".repeat(64)}`,
          definition_bundle_hash: DIGEST,
          execution_snapshot_hash: DIGEST,
          status: "succeeded",
          completeness: "complete",
        },
        graph_hash: DIGEST,
        outcome_hash: DIGEST,
        redaction_changed: true,
      },
      same_workflow_revision: false,
      summary: { added: 1, removed: 0, changed: 1, total: 2 },
      changes: [
        { kind: "changed", path: ["summary"], before: "old", after: "new" },
        { kind: "added", path: ["score"], after: 0.9 },
      ],
      truncated: false,
      redaction: "best_effort",
    })

    render(
      <RunNodeOutputComparison
        runId="run-current"
        nodeId="review"
        workflowId="code-review"
      />,
      { wrapper },
    )

    expect(list).not.toHaveBeenCalled()
    expect(compare).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Comparar com outra execução" }))
    const selection = await screen.findByRole("combobox", { name: "Execução anterior" })
    expect(list).toHaveBeenCalledWith(
      { workflowId: "code-review", limit: 100 },
      expect.any(AbortSignal),
    )
    expect(compare).not.toHaveBeenCalled()

    await screen.findByRole("option", { name: /run-before/ })
    fireEvent.change(selection, { target: { value: "run-before" } })
    const compareButton = screen.getByRole("button", { name: "Comparar outputs" })
    await waitFor(() => expect(compareButton.hasAttribute("disabled")).toBe(false))
    fireEvent.click(compareButton)

    expect(await screen.findByText("Revisões diferentes do workflow")).toBeDefined()
    expect(screen.getByText("summary")).toBeDefined()
    expect(screen.getByText("score")).toBeDefined()
    expect(compare).toHaveBeenCalledWith(
      "run-current",
      "review",
      "run-before",
      expect.any(AbortSignal),
    )
  })

  it("explains when one retained output is unavailable", async () => {
    vi.spyOn(studioApi, "runCatalogPage").mockResolvedValue({
      items: [{
        run_id: "run-before",
        workflow_id: "code-review",
        dispatch_status: "started",
        run_status: "succeeded",
        status: "succeeded",
        created_at: "2026-07-10T10:00:00.000Z",
        finished_at: "2026-07-10T10:00:02.000Z",
        artifact_count: 0,
        interrupt_count: 0,
        completeness: "complete",
        wall_duration_ms: 2_000,
      }],
      next_cursor: null,
      as_of: "2026-07-10T10:00:03.000Z",
    })
    vi.spyOn(studioApi, "compareRunNodeOutput").mockResolvedValue({
      schema_version: 1,
      availability: "unavailable",
      node_id: "review",
      baseline_run: {
        run_id: "run-before",
        workflow_id: "code-review",
        status: "succeeded",
        completeness: "complete",
      },
      current_run: {
        run_id: "run-current",
        workflow_id: "code-review",
        status: "succeeded",
        completeness: "complete",
      },
      reason: "output_unavailable",
      unavailable_sides: [{
        side: "baseline",
        reason: "snapshot_budget_exhausted",
      }],
    })

    render(
      <RunNodeOutputComparison
        runId="run-current"
        nodeId="review"
        workflowId="code-review"
      />,
      { wrapper },
    )
    fireEvent.click(screen.getByRole("button", { name: "Comparar com outra execução" }))
    const selection = await screen.findByRole("combobox")
    await screen.findByRole("option", { name: /run-before/ })
    fireEvent.change(selection, {
      target: { value: "run-before" },
    })
    const compareButton = screen.getByRole("button", { name: "Comparar outputs" })
    await waitFor(() => expect(compareButton.hasAttribute("disabled")).toBe(false))
    fireEvent.click(compareButton)

    expect(await screen.findByText(/limite total de outputs atingido/)).toBeDefined()
  })
})
