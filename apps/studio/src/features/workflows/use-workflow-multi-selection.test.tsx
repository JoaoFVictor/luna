import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useWorkflowMultiSelection } from "@/features/workflows/use-workflow-multi-selection"
import { workflowSourceNodes } from "@/features/workflows/workflow-source-model"

describe("useWorkflowMultiSelection", () => {
  it("promotes additive clicks to a multiple selection and deletes one canonical batch", () => {
    const nodes = workflowSourceNodes({ nodes: [
      { id: "a", type: "built_in", uses: "one" },
      { id: "b", type: "built_in", uses: "two", after: ["a"] },
      { id: "c", type: "built_in", uses: "three", after: ["a", "b"] },
    ] })
    const onOperations = vi.fn()
    const onSelectNode = vi.fn()
    const { result } = renderHook(() => useWorkflowMultiSelection({
      nodes,
      selectedNodeId: "a",
      canMutate: true,
      pending: false,
      onOperations,
      onSelectNode,
    }))

    act(() => result.current.select("b", true))
    expect(result.current.selectedNodeIds).toEqual(["a", "b"])
    expect(result.current.hasMultiple).toBe(true)
    expect(onSelectNode).toHaveBeenLastCalledWith("b")

    act(() => result.current.deleteMultiple())
    expect(onOperations).toHaveBeenCalledWith([
      { op: "delete", path: ["nodes", 2, "after"] },
      { op: "sequence_remove", path: ["nodes"], index: 1 },
      { op: "sequence_remove", path: ["nodes"], index: 0 },
    ])
    expect(onSelectNode).toHaveBeenLastCalledWith(undefined)
    expect(result.current.selectedNodeIds).toEqual([])
  })

  it("blocks a high-fanout single deletion before sending an invalid request", () => {
    const nodes = workflowSourceNodes({ nodes: [
      { id: "root", type: "built_in", uses: "root" },
      ...Array.from({ length: 64 }, (_, index) => ({
        id: `child-${index}`,
        type: "built_in" as const,
        uses: "child",
        after: ["root"],
      })),
    ] })
    const onOperations = vi.fn()
    const { result } = renderHook(() => useWorkflowMultiSelection({
      nodes,
      selectedNodeId: "root",
      canMutate: true,
      pending: false,
      onOperations,
      onSelectNode: vi.fn(),
    }))

    expect(result.current.singleDeleteUnavailableReason).toContain("65 operações")
    act(() => result.current.deleteSingle())
    expect(onOperations).not.toHaveBeenCalled()
  })
})
