import jsonata from "jsonata";

export type WorkflowExpression = {
  expression: string;
};

export const GLOBAL_EXPRESSION_ROOTS = new Set([
  "invocation",
  "repository",
  "run",
  "workspace",
  "config",
  "steps"
]);

export type ExpressionValidationContext = {
  path: string;
  capability?: string;
  nodeIds: ReadonlySet<string>;
  localRoots?: readonly string[];
};

export class WorkflowExpressionError extends Error {
  readonly code:
    | "workflow_expression_invalid"
    | "workflow_expression_unresolved"
    | "workflow_expression_context_shadow";
  readonly path: string;
  readonly capability?: string;

  constructor(
    code:
      | "workflow_expression_invalid"
      | "workflow_expression_unresolved"
      | "workflow_expression_context_shadow",
    message: string,
    options: { path: string; capability?: string }
  ) {
    super(message);
    this.name = "WorkflowExpressionError";
    this.code = code;
    this.path = options.path;
    this.capability = options.capability;
  }
}

export function isExpressionObject(value: unknown): value is WorkflowExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { expression?: unknown }).expression === "string"
  );
}

export function assertExpressionObject(
  value: unknown,
  path: string,
  capability?: string
): WorkflowExpression {
  if (!isExpressionObject(value) || Object.keys(value).length !== 1) {
    throw new WorkflowExpressionError(
      "workflow_expression_invalid",
      `Expression at ${path} for ${capability ?? "workflow"} must be an object with expression.`,
      { path, capability }
    );
  }
  return value;
}

export function assertLocalExpressionRoots(
  roots: readonly string[] | undefined,
  capability: string
): void {
  for (const root of roots ?? []) {
    const normalized = root.startsWith("$.") ? root.slice(2).split(".", 1)[0] : root;
    if (GLOBAL_EXPRESSION_ROOTS.has(normalized)) {
      throw new WorkflowExpressionError(
        "workflow_expression_context_shadow",
        `Capability ${capability} local expression root ${root} shadows a global root.`,
        { path: "$.local_context_roots", capability }
      );
    }
  }
}

export function validateWorkflowExpression(
  value: WorkflowExpression,
  context: ExpressionValidationContext
): void {
  try {
    jsonata(value.expression);
  } catch (cause) {
    throw new WorkflowExpressionError(
      "workflow_expression_invalid",
      `Invalid expression at ${context.path} for ${context.capability ?? "workflow"}.`,
      { path: context.path, capability: context.capability }
    );
  }

  const allowedRoots = new Set(GLOBAL_EXPRESSION_ROOTS);
  for (const root of context.localRoots ?? []) {
    allowedRoots.add(root.startsWith("$.") ? root.slice(2).split(".", 1)[0] : root);
  }

  for (const root of referencedRoots(value.expression)) {
    if (!allowedRoots.has(root)) {
      throw new WorkflowExpressionError(
        "workflow_expression_unresolved",
        `Expression at ${context.path} for ${context.capability ?? "workflow"} references unknown root $.${root}.`,
        { path: context.path, capability: context.capability }
      );
    }
  }

  for (const stepId of referencedStepIds(value.expression)) {
    if (!context.nodeIds.has(stepId)) {
      throw new WorkflowExpressionError(
        "workflow_expression_unresolved",
        `Expression at ${context.path} for ${context.capability ?? "workflow"} references unknown step ${stepId}.`,
        { path: context.path, capability: context.capability }
      );
    }
  }
}

export function detectStringExpression(value: unknown): boolean {
  return typeof value === "string" && /^\s*\$[.[a-zA-Z_]/.test(value);
}

function referencedRoots(expression: string): string[] {
  const roots = new Set<string>();
  const rootPattern = /\$\.([A-Za-z_][A-Za-z0-9_-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = rootPattern.exec(expression)) !== null) {
    roots.add(match[1]);
  }
  return [...roots];
}

function referencedStepIds(expression: string): string[] {
  const stepIds = new Set<string>();
  const stepPattern = /\$\.steps\.([A-Za-z_][A-Za-z0-9_-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = stepPattern.exec(expression)) !== null) {
    stepIds.add(match[1]);
  }
  return [...stepIds];
}
