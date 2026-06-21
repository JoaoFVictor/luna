import type {
  ImplementationLifecycleEvidence
} from "../write-mode/lifecycle.js";
import type {
  Invocation,
  RunIdentity,
  RuntimeConfigState,
  WorkspaceRecord
} from "../types.js";
import type { AppConfig, RepositoryConfig } from "../config/schemas.js";

export type WorkflowState = {
  invocation: unknown;
  config?: unknown;
  repository?: unknown;
  run?: unknown;
  workflow?: unknown;
  workspace?: unknown;
  workspaceRoot?: string;
  steps: Record<string, unknown>;
};

export type SchedulerWorkflowState = WorkflowState & {
  invocation: Invocation;
  config: RuntimeConfigState;
  repository?: RepositoryConfig;
  run: RunIdentity;
  workflow: {
    id: string;
    mode: "git_managed_read_only" | "git_managed_write";
  };
  workspaceRoot: AppConfig["workspace"]["root"];
  workspace?: WorkspaceRecord;
  lifecycleEvidence?: ImplementationLifecycleEvidence;
};

function workflowStateError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function valueAtPath(
  reference: string,
  rootName: string,
  root: unknown,
  pathSegments: string[]
): unknown {
  if (root === undefined) {
    throw workflowStateError(
      `Workflow input references missing ${rootName}`,
      "workflow_reference_missing"
    );
  }

  let current: unknown = root;

  for (const segment of pathSegments) {
    if (segment === "") {
      throw workflowStateError(
        `Unsupported workflow input reference: ${reference}`,
        "workflow_reference_unsupported"
      );
    }

    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      throw workflowStateError(
        `Workflow input references missing path: ${reference}`,
        "workflow_reference_missing"
      );
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function resolveObjectReference(
  reference: string,
  prefix: string,
  rootName: string,
  root: unknown
): unknown {
  if (reference === prefix) {
    return valueAtPath(reference, rootName, root, []);
  }

  return valueAtPath(
    reference,
    rootName,
    root,
    reference.slice(prefix.length + 1).split(".")
  );
}

function resolveReference(reference: string, state: WorkflowState): unknown {
  if (reference === "$.invocation") {
    return state.invocation;
  }

  for (const candidate of [
    {
      prefix: "$.config",
      rootName: "config",
      root: state.config
    },
    {
      prefix: "$.repository",
      rootName: "repository",
      root: state.repository
    },
    {
      prefix: "$.run",
      rootName: "run",
      root: state.run
    },
    {
      prefix: "$.workspace",
      rootName: "workspace",
      root: state.workspace
    }
  ]) {
    if (
      reference === candidate.prefix ||
      reference.startsWith(`${candidate.prefix}.`)
    ) {
      return resolveObjectReference(
        reference,
        candidate.prefix,
        candidate.rootName,
        candidate.root
      );
    }
  }

  if (reference.startsWith("$.steps.")) {
    const [stepId, ...pathSegments] = reference.slice("$.steps.".length).split(".");

    if (stepId === "") {
      throw workflowStateError(
        `Unsupported workflow input reference: ${reference}`,
        "workflow_reference_unsupported"
      );
    }

    if (!Object.prototype.hasOwnProperty.call(state.steps, stepId)) {
      throw workflowStateError(
        `Workflow input references missing step output: ${stepId}`,
        "workflow_reference_missing"
      );
    }

    return valueAtPath(
      reference,
      `step output: ${stepId}`,
      state.steps[stepId],
      pathSegments
    );
  }

  throw workflowStateError(
    `Unsupported workflow input reference: ${reference}`,
    "workflow_reference_unsupported"
  );
}

export function resolveWorkflowInput(
  input: Record<string, unknown> | undefined,
  state: WorkflowState
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input ?? {})) {
    resolved[key] =
      typeof value === "string" && value.startsWith("$.")
        ? resolveReference(value, state)
        : value;
  }

  return resolved;
}
