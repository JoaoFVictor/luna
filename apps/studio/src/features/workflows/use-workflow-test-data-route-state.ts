import { useCallback, useEffect, useMemo } from "react"
import { useSearchParams } from "react-router-dom"

export const WORKFLOW_TEST_DATA_PANEL = "test-data"
export const WORKFLOW_TEST_DATA_PARAM = "test_data"

export type WorkflowTestDataRouteSelection = {
  readonly panelOpen: boolean
  readonly activeFixtureNames: readonly string[]
  readonly previewFixtureName?: string
  readonly nodeId?: string
}

function canonicalActiveFixtureNames(
  names: readonly string[],
  fixtureNodeIds: ReadonlyMap<string, string>,
): readonly string[] {
  const selectedNodes = new Set<string>()
  const selected: string[] = []
  for (const name of [...new Set(names)].sort((left, right) => left.localeCompare(right))) {
    const nodeId = fixtureNodeIds.get(name)
    if (nodeId === undefined || selectedNodes.has(nodeId)) continue
    selectedNodes.add(nodeId)
    selected.push(name)
  }
  return selected
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function replaceTestDataParams(params: URLSearchParams, names: readonly string[]): void {
  params.delete(WORKFLOW_TEST_DATA_PARAM)
  for (const name of names) params.append(WORKFLOW_TEST_DATA_PARAM, name)
}

export function workflowTestDataRouteSelection(
  params: URLSearchParams,
  fixtureNames: ReadonlySet<string>,
  fixtureNodeIds: ReadonlyMap<string, string>,
  nodeIds: ReadonlySet<string>,
): WorkflowTestDataRouteSelection {
  const preview = params.get("fixture") ?? undefined
  const node = params.get("node") ?? undefined
  const previewFixtureName = preview !== undefined && fixtureNames.has(preview)
    ? preview
    : undefined
  return {
    panelOpen: params.get("panel") === WORKFLOW_TEST_DATA_PANEL,
    activeFixtureNames: canonicalActiveFixtureNames(
      params.getAll(WORKFLOW_TEST_DATA_PARAM),
      fixtureNodeIds,
    ),
    ...(previewFixtureName === undefined ? {} : { previewFixtureName }),
    ...(previewFixtureName !== undefined && node !== undefined && nodeIds.has(node)
      ? { nodeId: node }
      : {}),
  }
}

export function useWorkflowTestDataRouteState({
  ready,
  fixtureNames,
  fixtureNodeIds,
  nodeIds,
  onSelectNode,
}: {
  ready: boolean
  fixtureNames: ReadonlySet<string>
  fixtureNodeIds: ReadonlyMap<string, string>
  nodeIds: ReadonlySet<string>
  onSelectNode: (nodeId: string | undefined) => void
}) {
  const [params, setParams] = useSearchParams()
  const selection = useMemo(
    () => workflowTestDataRouteSelection(params, fixtureNames, fixtureNodeIds, nodeIds),
    [fixtureNames, fixtureNodeIds, nodeIds, params],
  )

  const update = useCallback((mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params)
    mutate(next)
    setParams(next, { replace: true })
  }, [params, setParams])

  useEffect(() => {
    if (!ready) return
    const currentActive = params.getAll(WORKFLOW_TEST_DATA_PARAM)
    const fixture = params.get("fixture")
    const node = params.get("node")
    const previewValid = fixture === null || fixtureNames.has(fixture)
    const nodeValid = node === null || (
      fixture !== null && fixtureNames.has(fixture) && nodeIds.has(node)
    )
    if (
      sameValues(currentActive, selection.activeFixtureNames) &&
      previewValid &&
      nodeValid
    ) return
    update((next) => {
      replaceTestDataParams(next, selection.activeFixtureNames)
      if (!previewValid) next.delete("fixture")
      if (!nodeValid) next.delete("node")
    })
  }, [fixtureNames, nodeIds, params, ready, selection.activeFixtureNames, update])

  useEffect(() => {
    if (ready && selection.nodeId !== undefined) onSelectNode(selection.nodeId)
  }, [onSelectNode, ready, selection.nodeId])

  const selectPreview = (next: URLSearchParams, fixtureName: string, nodeId?: string) => {
    next.set("fixture", fixtureName)
    if (nodeId === undefined) next.delete("node")
    else next.set("node", nodeId)
  }

  return {
    ...selection,
    openPanel: () => update((next) => next.set("panel", WORKFLOW_TEST_DATA_PANEL)),
    closePanel: () => update((next) => next.delete("panel")),
    selectPreviewFixture: (fixtureName: string, nodeId?: string) => update((next) => {
      next.set("panel", WORKFLOW_TEST_DATA_PANEL)
      selectPreview(next, fixtureName, nodeId)
    }),
    toggleTestData: (fixtureName: string, nodeId: string) => update((next) => {
      next.set("panel", WORKFLOW_TEST_DATA_PANEL)
      selectPreview(next, fixtureName, nodeId)
      const current = canonicalActiveFixtureNames(
        next.getAll(WORKFLOW_TEST_DATA_PARAM),
        fixtureNodeIds,
      )
      const active = current.includes(fixtureName)
      const names = active
        ? current.filter((name) => name !== fixtureName)
        : [...current.filter((name) => fixtureNodeIds.get(name) !== nodeId), fixtureName]
      replaceTestDataParams(next, canonicalActiveFixtureNames(names, fixtureNodeIds))
    }),
    clearPreview: () => update((next) => {
      next.delete("fixture")
      next.delete("node")
    }),
    removeFixture: (fixtureName: string) => update((next) => {
      replaceTestDataParams(
        next,
        canonicalActiveFixtureNames(
          next.getAll(WORKFLOW_TEST_DATA_PARAM).filter((name) => name !== fixtureName),
          fixtureNodeIds,
        ),
      )
      if (next.get("fixture") === fixtureName) {
        next.delete("fixture")
        next.delete("node")
      }
    }),
    clearAll: () => update((next) => {
      replaceTestDataParams(next, [])
      next.delete("fixture")
      next.delete("node")
    }),
  }
}
