import type { BuiltInStepMetadata } from "./built-ins/index.js";
import type { RunLogAttributes, RunLogger } from "./run-logger.js";
import type { WorkflowNode } from "./workflow-definition.js";
import type { SchedulerWorkflowState } from "./workflow-state.js";

export type SchedulerExecution = {
  max_concurrency: number;
};

export type SchedulerLockManager = {
  acquire(
    resource: string,
    mode: "exclusive",
    options?: { timeoutMs?: number }
  ): Promise<() => Promise<void>>;
};

export type WorkflowScheduleOptions = {
  nodes: WorkflowNode[];
  state: SchedulerWorkflowState;
  execution: SchedulerExecution;
  logger: RunLogger;
  lockManager?: SchedulerLockManager;
  runNode: (options: {
    node: WorkflowNode;
    state: SchedulerWorkflowState;
  }) => unknown | Promise<unknown>;
  writeNodeArtifact: (
    node: WorkflowNode,
    output: unknown
  ) => unknown | Promise<unknown>;
  builtInMetadata: (node: WorkflowNode) => BuiltInStepMetadata;
};

export type WorkflowScheduleResult = {
  status: "success" | "failed";
  steps: Record<string, unknown>;
  workspace?: SchedulerWorkflowState["workspace"];
};

type SchedulerStepFailure = {
  status: "failed";
  code: "scheduler_step_failed";
  message: string;
  details: {
    step_id: string;
    cause_code?: string;
  };
};

function schedulerError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }

  return String(error);
}

function emitRunLog(
  logger: RunLogger,
  level: keyof RunLogger,
  event: string,
  attributes: RunLogAttributes
): void {
  try {
    logger[level](event, attributes);
  } catch {
    return;
  }
}

function isWorkspaceRecord(
  output: unknown
): output is SchedulerWorkflowState["workspace"] {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return false;
  }

  const candidate = output as Partial<
    NonNullable<SchedulerWorkflowState["workspace"]>
  >;
  return (
    typeof candidate.run_id === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.preserved === "boolean" &&
    typeof candidate.reason === "string"
  );
}

function cloneState(state: SchedulerWorkflowState): SchedulerWorkflowState {
  return structuredClone(state) as SchedulerWorkflowState;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return value;
}

function snapshotState(state: SchedulerWorkflowState): SchedulerWorkflowState {
  const snapshot = cloneState(state);

  if (process.env.NODE_ENV !== "production") {
    deepFreeze(snapshot);
  }

  return snapshot;
}

function dependencySkipped(stepId: string): {
  status: "skipped";
  code: "scheduler_dependency_failed";
  step_id: string;
} {
  return {
    status: "skipped",
    code: "scheduler_dependency_failed",
    step_id: stepId
  };
}

function duplicateWorkspaceError(stepId: string): Error & { code: string } {
  return schedulerError(
    `Workflow node ${stepId} attempted to capture workspace more than once`,
    "workflow_workspace_duplicate"
  );
}

export function splitDeferredFinalReportNodes(
  nodes: WorkflowNode[],
  builtInMetadata: (node: WorkflowNode) => BuiltInStepMetadata
): { mainNodes: WorkflowNode[]; deferredNodes: WorkflowNode[] } {
  const deferredIds = new Set(
    nodes
      .filter(
        (node) =>
          builtInMetadata(node).deferUntilAfterWorkspaceLifecycle === true
      )
      .map((node) => node.id)
  );

  for (const node of nodes) {
    if (deferredIds.has(node.id)) {
      continue;
    }

    for (const dependency of node.after ?? []) {
      if (deferredIds.has(dependency)) {
        throw schedulerError(
          "Non-deferred node depends on deferred final report",
          "workflow_deferred_dependency_invalid"
        );
      }
    }
  }

  return {
    mainNodes: nodes.filter((node) => !deferredIds.has(node.id)),
    deferredNodes: nodes.filter((node) => deferredIds.has(node.id))
  };
}

async function withLocks<T>(
  _node: WorkflowNode,
  state: SchedulerWorkflowState,
  metadata: BuiltInStepMetadata,
  lockManager: SchedulerLockManager | undefined,
  run: () => Promise<T>
): Promise<T> {
  const releases: (() => Promise<void>)[] = [];
  let operationError: unknown;

  try {
    for (const lock of metadata.locks ?? []) {
      if (lock.resource === "repository") {
        if (state.repository === undefined) {
          throw schedulerError(
            "Repository lock resource is missing",
            "lock_resource_missing"
          );
        }

        if (lockManager === undefined) {
          throw schedulerError(
            "Lock manager is missing",
            "lock_manager_missing"
          );
        }

        releases.push(
          await lockManager.acquire(
            `repository:${state.repository.id}`,
            lock.mode
          )
        );
      }
    }

    return await run();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const releaseErrors: unknown[] = [];

    for (const release of releases.reverse()) {
      try {
        await release();
      } catch (error) {
        releaseErrors.push(error);
      }
    }

    if (releaseErrors.length > 0) {
      if (operationError !== undefined) {
        if (
          (typeof operationError === "object" && operationError !== null) ||
          typeof operationError === "function"
        ) {
          Object.defineProperty(operationError, "releaseErrors", {
            configurable: true,
            value: releaseErrors
          });
        }
      } else {
        throw schedulerError(
          "Failed to release workflow lock",
          "lock_release_failed"
        );
      }
    }
  }
}

export function schedulerStepFailed(
  stepId: string,
  cause: unknown
): SchedulerStepFailure {
  const causeCode = errorCode(cause);

  return {
    status: "failed",
    code: "scheduler_step_failed",
    message: errorMessage(cause),
    details: {
      step_id: stepId,
      ...(causeCode === undefined ? {} : { cause_code: causeCode })
    }
  };
}

export async function runWorkflowSchedule({
  nodes,
  state,
  execution: _execution,
  logger,
  lockManager,
  runNode,
  writeNodeArtifact,
  builtInMetadata
}: WorkflowScheduleOptions): Promise<WorkflowScheduleResult> {
  const pending = new Map(nodes.map((node) => [node.id, node]));
  const completed = new Set<string>();
  const blocked = new Set<string>();
  const steps: Record<string, unknown> = {};
  let workspace = state.workspace;
  const scheduleState: SchedulerWorkflowState = {
    ...state,
    steps: { ...state.steps },
    ...(workspace === undefined ? {} : { workspace })
  };

  while (pending.size > 0) {
    let skippedDependency = false;

    for (const node of [...pending.values()]) {
      if ((node.after ?? []).some((dependency) => blocked.has(dependency))) {
        const skipped = dependencySkipped(node.id);
        steps[node.id] = skipped;
        scheduleState.steps[node.id] = skipped;
        blocked.add(node.id);
        pending.delete(node.id);
        skippedDependency = true;
        emitRunLog(logger, "warn", "luna.scheduler.step_failed", {
          "luna.run_id": state.run.run_id,
          "luna.flue_run_id": state.run.flue_run_id,
          "luna.workflow_id": state.workflow.id,
          "luna.step_id": node.id,
          "error.code": skipped.code
        });
      }
    }

    if (skippedDependency) {
      continue;
    }

    const ready = [...pending.values()]
      .filter((node) =>
        (node.after ?? []).every((dependency) => completed.has(dependency))
      )
      .slice(0, 1);

    if (ready.length === 0) {
      throw schedulerError(
        "Workflow graph cannot be ordered",
        "workflow_graph_unorderable"
      );
    }

    for (const node of ready) {
      emitRunLog(logger, "info", "luna.scheduler.step_started", {
        "luna.run_id": state.run.run_id,
        "luna.flue_run_id": state.run.flue_run_id,
        "luna.workflow_id": state.workflow.id,
        "luna.step_id": node.id
      });

      try {
        const metadata = builtInMetadata(node);
        const snapshot = snapshotState(scheduleState);
        const output = await withLocks(
          node,
          snapshot,
          metadata,
          lockManager,
          async () =>
            await runNode({
              node,
              state: snapshot
            })
        );
        const capturesWorkspace = metadata.capturesWorkspace === true;
        const capturedWorkspace =
          capturesWorkspace && isWorkspaceRecord(output) ? output : undefined;

        if (capturesWorkspace) {
          if (workspace !== undefined) {
            throw duplicateWorkspaceError(node.id);
          }
        }

        await writeNodeArtifact(node, output);
        if (capturedWorkspace !== undefined) {
          workspace = capturedWorkspace;
          scheduleState.workspace = capturedWorkspace;
        }
        steps[node.id] = output;
        scheduleState.steps[node.id] = output;
        completed.add(node.id);
        pending.delete(node.id);

        emitRunLog(logger, "info", "luna.scheduler.step_finished", {
          "luna.run_id": state.run.run_id,
          "luna.flue_run_id": state.run.flue_run_id,
          "luna.workflow_id": state.workflow.id,
          "luna.step_id": node.id
        });
      } catch (cause) {
        if (
          errorCode(cause) === "lock_resource_missing" ||
          errorCode(cause) === "lock_manager_missing"
        ) {
          throw cause;
        }

        const failure = schedulerStepFailed(node.id, cause);
        steps[node.id] = failure;
        scheduleState.steps[node.id] = failure;
        blocked.add(node.id);
        pending.delete(node.id);

        emitRunLog(logger, "error", "luna.scheduler.step_failed", {
          "luna.run_id": state.run.run_id,
          "luna.flue_run_id": state.run.flue_run_id,
          "luna.workflow_id": state.workflow.id,
          "luna.step_id": node.id,
          "error.code": failure.code,
          "error.cause_code": failure.details.cause_code
        });
      }
    }
  }

  return {
    status: blocked.size > 0 ? "failed" : "success",
    steps,
    ...(workspace === undefined ? {} : { workspace })
  };
}
