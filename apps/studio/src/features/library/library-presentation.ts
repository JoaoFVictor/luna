const CATEGORY_RULES: readonly [RegExp, string][] = [
  [/agents|review/u, "Agents e IA"],
  [/context|diff|task-context/u, "Contexto e dados"],
  [/git|repository|change-request/u, "Repositório"],
  [/artifact|report|finding|validation/u, "Resultados"],
  [/gate|hitl|quality/u, "Fluxo e aprovação"],
  [/runtime|local-exec/u, "Utilitários"],
]

export function capabilityCategory(id: string, declared: string | undefined): string {
  if (declared !== undefined && declared.trim().length > 0) return declared
  return CATEGORY_RULES.find(([pattern]) => pattern.test(id))?.[1] ?? "Outros"
}
