import type { JsonValue, WorkflowSummary } from "@/api/types"

function parentWorkflowMode(
  source: JsonValue,
): "read_only" | "trusted_local_write" | undefined {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined
  return source.mode === "read_only" || source.mode === "trusted_local_write"
    ? source.mode
    : undefined
}

export function workflowCompositionIssue(
  parentSource: JsonValue,
  child: WorkflowSummary,
): string | undefined {
  if (child.synchronous_composition === "blocked") {
    return "Este workflow contém aprovação humana e ainda não pode executar como subworkflow síncrono."
  }
  const parentMode = parentWorkflowMode(parentSource)
  if (parentMode === undefined) {
    return "Defina um mode válido no workflow atual antes de adicionar um subworkflow."
  }
  if (parentMode === "read_only" && child.mode === "trusted_local_write") {
    return "Um workflow read_only não pode executar um subworkflow trusted_local_write."
  }
  return undefined
}

export function composableChildWorkflows(
  parentSource: JsonValue,
  workflows: readonly WorkflowSummary[],
): WorkflowSummary[] {
  return workflows.filter((workflow) =>
    workflowCompositionIssue(parentSource, workflow) === undefined,
  )
}
