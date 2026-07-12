import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import {
  useWorkflowTestDataRouteState,
  workflowTestDataRouteSelection,
} from "@/features/workflows/use-workflow-test-data-route-state"

const FIXTURE_NAMES = new Set(["approved review", "context data", "review alternate", "manual"])
const FIXTURE_NODE_IDS = new Map([
  ["approved review", "review"],
  ["review alternate", "review"],
  ["context data", "context"],
])
const NODE_IDS = new Set(["review", "context"])

function Harness({ onSelectNode }: { onSelectNode: (nodeId: string | undefined) => void }) {
  const location = useLocation()
  const route = useWorkflowTestDataRouteState({
    ready: true,
    fixtureNames: FIXTURE_NAMES,
    fixtureNodeIds: FIXTURE_NODE_IDS,
    nodeIds: NODE_IDS,
    onSelectNode,
  })
  return (
    <>
      <output aria-label="location">{location.search}</output>
      <output aria-label="active">{route.activeFixtureNames.join("|") || "none"}</output>
      <output aria-label="preview">{route.previewFixtureName ?? "none"}</output>
      <button onClick={() => route.toggleTestData("approved review", "review")}>toggle review</button>
      <button onClick={() => route.toggleTestData("context data", "context")}>toggle context</button>
      <button onClick={() => route.toggleTestData("review alternate", "review")}>replace review</button>
      <button onClick={() => route.selectPreviewFixture("manual")}>preview manual</button>
      <button onClick={route.clearAll}>clear all</button>
    </>
  )
}

describe("workflow test-data route state", () => {
  it("keeps only known eligible fixtures and one deterministic fixture per node", () => {
    expect(workflowTestDataRouteSelection(
      new URLSearchParams("panel=test-data&test_data=review+alternate&test_data=unknown&test_data=approved+review&test_data=context+data&fixture=manual"),
      FIXTURE_NAMES,
      FIXTURE_NODE_IDS,
      NODE_IDS,
    )).toEqual({
      panelOpen: true,
      activeFixtureNames: ["approved review", "context data"],
      previewFixtureName: "manual",
    })
  })

  it("restores deep links, toggles independent nodes, replaces a fixture on the same node, and clears all", async () => {
    const onSelectNode = vi.fn()
    render(
      <MemoryRouter initialEntries={["/drafts/one?panel=test-data&test_data=context+data&fixture=approved+review&node=review"]}>
        <Harness onSelectNode={onSelectNode} />
      </MemoryRouter>,
    )

    expect(screen.getByLabelText("active").textContent).toBe("context data")
    expect(screen.getByLabelText("preview").textContent).toBe("approved review")
    await waitFor(() => expect(onSelectNode).toHaveBeenCalledWith("review"))

    fireEvent.click(screen.getByRole("button", { name: "toggle review" }))
    expect(screen.getByLabelText("active").textContent).toBe("approved review|context data")
    fireEvent.click(screen.getByRole("button", { name: "replace review" }))
    expect(screen.getByLabelText("active").textContent).toBe("context data|review alternate")
    expect(screen.getByLabelText("location").textContent).toContain("test_data=context+data")
    expect(screen.getByLabelText("location").textContent).toContain("test_data=review+alternate")

    fireEvent.click(screen.getByRole("button", { name: "preview manual" }))
    expect(screen.getByLabelText("preview").textContent).toBe("manual")
    expect(screen.getByLabelText("active").textContent).toBe("context data|review alternate")

    fireEvent.click(screen.getByRole("button", { name: "clear all" }))
    expect(screen.getByLabelText("active").textContent).toBe("none")
    expect(screen.getByLabelText("preview").textContent).toBe("none")
    expect(screen.getByLabelText("location").textContent).toBe("?panel=test-data")
  })
})
