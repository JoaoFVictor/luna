import type { RouterDefinition } from "@/api/types"
import { humanizeTechnicalId } from "@/lib/presentation"

type RouterRule = RouterDefinition["rules"][number]

function quotedValue(expression: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  return expression.match(new RegExp(`\\$\\.invocation\\.${escaped}\\s*=\\s*['"]([^'"]+)['"]`, "u"))?.[1]
}

function listedValues(expression: string, field: string): readonly string[] {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const list = expression.match(new RegExp(`\\$\\.invocation\\.${escaped}\\s+in\\s+\\[([^\\]]+)\\]`, "u"))?.[1]
  return list === undefined
    ? []
    : [...list.matchAll(/['"]([^'"]+)['"]/gu)].flatMap((match) => match[1] ?? [])
}

export function routingTargetLabel(target: RouterRule["target"]): string {
  if (target === "$.invocation.target") return "o destino informado na entrada"
  return humanizeTechnicalId(target.replace(/^workflow:/u, ""))
}

export function routingRuleDescription(rule: RouterRule): string {
  if (rule.target === "$.invocation.target") {
    return "Se a entrada já informar um destino, respeitar esse workflow"
  }
  const source = quotedValue(rule.when.expression, "source")
  const event = quotedValue(rule.when.expression, "event")
  const action = quotedValue(rule.when.expression, "action")
  const actions = listedValues(rule.when.expression, "action")
  const conditions = [
    source === undefined ? undefined : `origem é ${humanizeTechnicalId(source)}`,
    event === undefined ? undefined : `evento é ${humanizeTechnicalId(event)}`,
    action === undefined
      ? actions.length === 0
        ? undefined
        : `ação é ${actions.map((value) => humanizeTechnicalId(value)).join(", ")}`
      : `ação é ${humanizeTechnicalId(action)}`,
  ].filter((value): value is string => value !== undefined)
  return conditions.length === 0
    ? `Quando a condição da regra combinar, enviar para ${routingTargetLabel(rule.target)}`
    : `Se ${conditions.join(" e ")}, enviar para ${routingTargetLabel(rule.target)}`
}
