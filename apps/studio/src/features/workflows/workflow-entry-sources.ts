import type {
  InputAdapterSummary,
  RouterDefinition,
} from "@/api/types"

export type WorkflowEntrySource = {
  readonly adapter: InputAdapterSummary
  readonly ruleIds: readonly string[]
}

function routedSources(
  routing: RouterDefinition,
  workflowId: string,
): ReadonlyMap<string, readonly string[]> {
  const rulesBySource = new Map<string, string[]>()
  for (const rule of routing.rules) {
    if (rule.target !== `workflow:${workflowId}`) continue
    const matches = rule.when.expression.matchAll(
      /\$\.invocation\.source\s*=\s*(['"])([^'"]+)\1/gu,
    )
    for (const match of matches) {
      const source = match[2]
      if (source === undefined) continue
      rulesBySource.set(source, [...(rulesBySource.get(source) ?? []), rule.id])
    }
  }
  return rulesBySource
}

/**
 * Projects deterministic routing as a read-only workflow entry. The adapter is
 * deliberately not inserted into workflow YAML: routing remains the authority
 * that chooses the workflow.
 */
export function workflowEntrySources(
  adapters: readonly InputAdapterSummary[],
  routing: RouterDefinition,
  workflowId: string,
): readonly WorkflowEntrySource[] {
  const rulesBySource = routedSources(routing, workflowId)
  return adapters.flatMap((adapter) => {
    const ruleIds = rulesBySource.get(adapter.source)
    return ruleIds === undefined ? [] : [{ adapter, ruleIds }]
  })
}
