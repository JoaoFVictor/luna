import type { JsonValue } from "@/api/types"
import type {
  WorkflowExpressionFixtureSource,
  WorkflowExpressionFixtureSources,
  WorkflowExpressionFixtures,
} from "@/features/workflows/workflow-expression-fixtures"

export type WorkflowTestDataEligibility =
  | { readonly kind: "eligible"; readonly nodeId: string }
  | { readonly kind: "preview_only"; readonly reason: "manual" | "node_missing" | "redacted" }

export type WorkflowTestDataEntry = {
  readonly name: string
  readonly value: JsonValue
  readonly source?: WorkflowExpressionFixtureSource
  readonly eligibility: WorkflowTestDataEligibility
  readonly redacted: boolean
}

export type WorkflowNodeTestDataState = "saved" | "active"

export function workflowTestDataEntries(
  fixtures: WorkflowExpressionFixtures,
  sources: WorkflowExpressionFixtureSources,
  nodeIds: ReadonlySet<string>,
): readonly WorkflowTestDataEntry[] {
  return Object.entries(fixtures)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      const source = sources[name]
      const eligibility: WorkflowTestDataEligibility = source === undefined
        ? { kind: "preview_only", reason: "manual" }
        : source.redaction_changed
          ? { kind: "preview_only", reason: "redacted" }
          : nodeIds.has(source.node_id)
          ? { kind: "eligible", nodeId: source.node_id }
          : { kind: "preview_only", reason: "node_missing" }
      return {
        name,
        value,
        ...(source === undefined ? {} : { source }),
        eligibility,
        redacted: source?.redaction_changed ?? false,
      }
    })
}

export function workflowNodeTestDataStates(
  entries: readonly WorkflowTestDataEntry[],
  activeFixtureNames: ReadonlySet<string>,
): ReadonlyMap<string, WorkflowNodeTestDataState> {
  const states = new Map<string, WorkflowNodeTestDataState>()
  for (const entry of entries) {
    const nodeId = entry.source?.node_id
    if (nodeId === undefined || entry.eligibility.kind !== "eligible") continue
    const next = activeFixtureNames.has(entry.name) ? "active" : "saved"
    if (next === "active" || !states.has(nodeId)) states.set(nodeId, next)
  }
  return states
}
