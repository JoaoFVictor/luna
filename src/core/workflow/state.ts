import type {
  ImplementationLifecycleEvidence
} from "../write-mode/lifecycle.js";
import type { Invocation } from "../router/invocation.js";
import type { RunIdentity } from "../invocation/types.js";
import type { RuntimeConfigState } from "../configured-workflow/contracts.js";
import type { WorkspaceRecord } from "../write-mode/types.js";
import {
  RepositoryConfigSchema,
  type AppConfig,
  type RepositoryConfig
} from "../config/schemas.js";

export type WorkflowState = {
  invocation: unknown;
  config?: unknown;
  repository?: unknown;
  run?: unknown;
  workflow?: unknown;
  workspace?: unknown;
  workspaceRoot?: string;
  agentsRoot?: string;
  steps: Record<string, unknown>;
};

export type SchedulerWorkflowState = WorkflowState & {
  invocation: Invocation;
  config: RuntimeConfigState;
  repository?: RepositoryConfig;
  run: RunIdentity;
  workflow: {
    id: string;
    mode: "read_only" | "trusted_local_write";
  };
  workspaceRoot: AppConfig["workspace"]["root"];
  agentsRoot: string;
  workspace?: WorkspaceRecord;
  lifecycleEvidence?: ImplementationLifecycleEvidence;
};

export function repositoryConfigFromState(
  state: Pick<WorkflowState, "repository">
): RepositoryConfig | undefined {
  if (state.repository === undefined) {
    return undefined;
  }

  return RepositoryConfigSchema.parse(state.repository);
}

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
  for (const candidate of [
    {
      prefix: "$.invocation",
      rootName: "invocation",
      root: state.invocation
    },
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
  return resolveWorkflowValue(input ?? {}, state) as Record<string, unknown>;
}

function resolveWorkflowValue(value: unknown, state: WorkflowState): unknown {
  if (typeof value === "string" && value.startsWith("$.")) {
    return resolveReference(value, state);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveWorkflowValue(item, state));
  }

  if (typeof value === "object" && value !== null) {
    if (
      Object.keys(value).length === 1 &&
      typeof (value as { expression?: unknown }).expression === "string"
    ) {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveWorkflowValue(item, state)
      ])
    );
  }

  return value;
}
