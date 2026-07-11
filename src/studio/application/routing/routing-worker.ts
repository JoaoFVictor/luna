import { parentPort, workerData } from "node:worker_threads";
import type { Invocation } from "../../../core/router/invocation.js";
import type { RouterDefinition } from "../../../core/router/router-definition.js";
import type {
  RouteInvocationDecision,
  RouterError,
  RouterRuleEvaluation
} from "../../../core/router/router.js";

type RouterModule = Pick<
  typeof import("../../../core/router/router.js"),
  "decideInvocationRoute"
>;

function respond(message: unknown): void {
  parentPort?.postMessage(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadRouter(): Promise<RouterModule> {
  if (import.meta.url.endsWith(".ts")) {
    // Source-mode workers do not inherit the host's TS loader. The scoped
    // import keeps tests/dev on the canonical router; compiled workers take
    // the dependency-free branch below.
    const { tsImport } = await import("tsx/esm/api");
    return (await tsImport("../../../core/router/router.ts", {
      parentURL: import.meta.url
    })) as RouterModule;
  }
  return await import("../../../core/router/router.js");
}

function diagnosticFor(
  error: RouterError,
  rule?: { readonly ruleId: string; readonly ruleIndex: number }
): unknown {
  return {
    severity: error.code === "router_no_match" ? "warning" : "error",
    code: error.code,
    message: error.message,
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(rule === undefined
      ? {}
      : { rule_id: rule.ruleId, rule_index: rule.ruleIndex })
  };
}

function projectEvaluation(evaluation: RouterRuleEvaluation): unknown {
  const common = {
    rule_id: evaluation.ruleId,
    rule_index: evaluation.ruleIndex,
    expression_path: evaluation.expressionPath
  };
  return evaluation.outcome === "error"
    ? {
        ...common,
        outcome: "error",
        diagnostic: diagnosticFor(evaluation.error, evaluation)
      }
    : {
        ...common,
        outcome: "boolean",
        result: evaluation.result
      };
}

function projectDecision(decision: RouteInvocationDecision): unknown {
  const evaluations = decision.evaluations.map(projectEvaluation);
  if (decision.outcome === "matched") {
    return {
      status: "matched",
      evaluations,
      matched_rule: {
        rule_id: decision.matchedRule.ruleId,
        rule_index: decision.matchedRule.ruleIndex
      },
      target: decision.target,
      diagnostics: []
    };
  }

  const matchedRule =
    decision.matchedRule === undefined
      ? null
      : {
          rule_id: decision.matchedRule.ruleId,
          rule_index: decision.matchedRule.ruleIndex
        };
  const lastEvaluation = evaluations.at(-1) as
    | { readonly diagnostic?: unknown; readonly outcome?: unknown }
    | undefined;
  const diagnostic =
    lastEvaluation?.outcome === "error"
      ? lastEvaluation.diagnostic
      : diagnosticFor(decision.error, decision.matchedRule);
  return {
    status: decision.error.code === "router_no_match" ? "no_match" : "error",
    evaluations,
    matched_rule: matchedRule,
    target: null,
    diagnostics: [diagnostic]
  };
}

if (
  !isRecord(workerData) ||
  !isRecord(workerData.invocation) ||
  !isRecord(workerData.definition) ||
  !Array.isArray(workerData.definition.rules)
) {
  respond({ kind: "failed" });
} else {
  try {
    const router = await loadRouter();
    const decision = await router.decideInvocationRoute(
      workerData.invocation as Invocation,
      workerData.definition as RouterDefinition
    );
    respond({ kind: "simulation", simulation: projectDecision(decision) });
  } catch {
    respond({ kind: "failed" });
  }
}
