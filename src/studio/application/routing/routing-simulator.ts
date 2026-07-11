import type { RouterDefinition } from "../../../core/router/router-definition.js";
import {
  decideInvocationRoute,
  type RouterError,
  type RouterRuleEvaluation
} from "../../../core/router/router.js";
import {
  StudioRoutingDiagnosticSchema,
  StudioRoutingSimulationRequestSchema,
  StudioRoutingSimulationSchema,
  type StudioRoutingDiagnostic,
  type StudioRoutingRuleEvaluation,
  type StudioRoutingSimulation
} from "../../contracts/input-routing.js";

function diagnosticFor(
  error: RouterError,
  rule?: { readonly ruleId: string; readonly ruleIndex: number }
): StudioRoutingDiagnostic {
  return StudioRoutingDiagnosticSchema.parse({
    severity: error.code === "router_no_match" ? "warning" : "error",
    code: error.code,
    message: error.message,
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(rule === undefined
      ? {}
      : { rule_id: rule.ruleId, rule_index: rule.ruleIndex })
  });
}

function toStudioEvaluation(
  evaluation: RouterRuleEvaluation
): StudioRoutingRuleEvaluation {
  const common = {
    rule_id: evaluation.ruleId,
    rule_index: evaluation.ruleIndex,
    expression_path: evaluation.expressionPath
  };

  if (evaluation.outcome === "error") {
    return {
      ...common,
      outcome: "error",
      diagnostic: diagnosticFor(evaluation.error, evaluation)
    };
  }

  return {
    ...common,
    outcome: "boolean",
    result: evaluation.result
  };
}

export async function simulateStudioRouting(
  request: unknown,
  definition: RouterDefinition
): Promise<StudioRoutingSimulation> {
  const parsed = StudioRoutingSimulationRequestSchema.parse(request);
  const decision = await decideInvocationRoute(parsed.invocation, definition);
  const evaluations = decision.evaluations.map(toStudioEvaluation);

  if (decision.outcome === "matched") {
    return StudioRoutingSimulationSchema.parse({
      status: "matched",
      evaluations,
      matched_rule: {
        rule_id: decision.matchedRule.ruleId,
        rule_index: decision.matchedRule.ruleIndex
      },
      target: decision.target,
      diagnostics: []
    });
  }

  const matchedRule = decision.matchedRule === undefined
    ? null
    : {
        rule_id: decision.matchedRule.ruleId,
        rule_index: decision.matchedRule.ruleIndex
      };
  const lastEvaluation = evaluations.at(-1);
  const diagnostic =
    lastEvaluation?.outcome === "error"
      ? lastEvaluation.diagnostic
      : diagnosticFor(decision.error, decision.matchedRule);

  return StudioRoutingSimulationSchema.parse({
    status: decision.error.code === "router_no_match" ? "no_match" : "error",
    evaluations,
    matched_rule: matchedRule,
    target: null,
    diagnostics: [diagnostic]
  });
}
