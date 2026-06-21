import type { BuiltInStepMetadata } from "./built-ins/index.js";
import type { LunaObservability } from "./observability/luna-observability.js";
import {
  recordFailedStep,
  type ObservabilitySummary
} from "./observability/summary.js";
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
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  lockManager?: SchedulerLockManager;
  runNode: (options: {
    node: WorkflowNode;
    state: SchedulerWorkflowState;
  }) => unknown | Promise<unknown>;
  writePlannedArtifacts: (
    node: WorkflowNode,
    output: unknown,
    state: SchedulerWorkflowState
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

function artifactTargets(node: WorkflowNode): string[] {
  return (node.artifacts ?? []).map((artifact) => artifact.path);
}

function isAgentLike(node: WorkflowNode): boolean {
  return node.type === "agent" || node.type === "agent_loop";
}

function selectReadyBatch(
  ready: WorkflowNode[],
  maxConcurrency: number,
  builtInMetadata: (node: WorkflowNode) => BuiltInStepMetadata
): WorkflowNode[] {
  const selected: WorkflowNode[] = [];
  const selectedTargets = new Set<string>();
  let hasAgentLike = false;
  let hasWorkspaceCapture = false;

  for (const node of ready) {
    if (selected.length >= maxConcurrency) {
      break;
    }

    const nodeTargets = artifactTargets(node);
    if (nodeTargets.some((target) => selectedTargets.has(target))) {
      continue;
    }

    if (isAgentLike(node) && hasAgentLike) {
      continue;
    }

    const metadata = builtInMetadata(node);
    if (metadata.capturesWorkspace === true && hasWorkspaceCapture) {
      continue;
    }

    selected.push(node);
    for (const target of nodeTargets) {
      selectedTargets.add(target);
    }

    if (isAgentLike(node)) {
      hasAgentLike = true;
    }
    if (metadata.capturesWorkspace === true) {
      hasWorkspaceCapture = true;
    }
  }

  return selected.length > 0 ? selected : ready.slice(0, 1);
}

function normalizedMaxConcurrency(maxConcurrency: number): number {
  return Number.isSafeInteger(maxConcurrency) && maxConcurrency > 0
    ? maxConcurrency
    : 1;
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

function preflightLocks(
  batch: WorkflowNode[],
  state: SchedulerWorkflowState,
  lockManager: SchedulerLockManager | undefined,
  builtInMetadata: (node: WorkflowNode) => BuiltInStepMetadata
): void {
  for (const node of batch) {
    for (const lock of builtInMetadata(node).locks ?? []) {
      if (lock.resource === "repository" && state.repository === undefined) {
        throw schedulerError(
          "Repository lock resource is missing",
          "lock_resource_missing"
        );
      }

      if (lock.resource === "repository" && lockManager === undefined) {
        throw schedulerError("Lock manager is missing", "lock_manager_missing");
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
  execution,
  observability,
  summary,
  lockManager,
  runNode,
  writePlannedArtifacts,
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
  const maxConcurrency = normalizedMaxConcurrency(execution.max_concurrency);

  async function emitSchedulerEvent(
    level: "info" | "warn" | "error",
    event: string,
    attributes: Record<string, unknown>
  ): Promise<void> {
    if (observability === undefined) {
      return;
    }

    try {
      await observability.emit(level, event, attributes);
    } catch (error) {
      if (observability.isHardFailed()) {
        throw error;
      }
    }
  }

  async function runOneNode(node: WorkflowNode): Promise<{
    node: WorkflowNode;
    output: unknown;
    capturedWorkspace?: SchedulerWorkflowState["workspace"];
  }> {
    const startedAt = Date.now();
    await emitSchedulerEvent("info", "luna.scheduler.step.started", {
      step_id: node.id,
      node_type: node.type,
      status: "started"
    });

    const metadata = builtInMetadata(node);
    try {
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

      if (capturesWorkspace && workspace !== undefined) {
        throw duplicateWorkspaceError(node.id);
      }

      await writePlannedArtifacts(node, output, scheduleState);
      try {
        await emitSchedulerEvent("info", "luna.scheduler.step.finished", {
          step_id: node.id,
          node_type: node.type,
          status: "completed",
          duration_ms: Date.now() - startedAt
        });
      } catch (error) {
        if (capturedWorkspace !== undefined) {
          Object.defineProperty(error, "workspaceRecord", {
            configurable: true,
            value: capturedWorkspace
          });
        }

        throw error;
      }

      return {
        node,
        output,
        ...(capturedWorkspace === undefined ? {} : { capturedWorkspace })
      };
    } catch (error) {
      await emitSchedulerEvent("error", "luna.scheduler.step.failed", {
        step_id: node.id,
        node_type: node.type,
        status: "failed",
        duration_ms: Date.now() - startedAt,
        error
      });
      throw error;
    }
  }

  while (pending.size > 0) {
    if (observability?.isHardFailed() === true) {
      throw observability.hardFailure();
    }

    let skippedDependency = false;

    for (const node of [...pending.values()]) {
      if ((node.after ?? []).some((dependency) => blocked.has(dependency))) {
        const skipped = dependencySkipped(node.id);
        steps[node.id] = skipped;
        scheduleState.steps[node.id] = skipped;
        blocked.add(node.id);
        pending.delete(node.id);
        skippedDependency = true;
        recordFailedStep(summary, {
          stepId: node.id,
          code: skipped.code,
          message: "Workflow dependency failed"
        });
        await emitSchedulerEvent("warn", "luna.scheduler.step.failed", {
          step_id: node.id,
          node_type: node.type,
          status: "skipped",
          error: {
            code: skipped.code,
            message: "Workflow dependency failed"
          }
        });
      }
    }

    if (skippedDependency) {
      continue;
    }

    const ready = [...pending.values()]
      .filter((node) =>
        (node.after ?? []).every((dependency) => completed.has(dependency))
      );

    if (ready.length === 0) {
      throw schedulerError(
        "Workflow graph cannot be ordered",
        "workflow_graph_unorderable"
      );
    }

    if (observability?.isHardFailed() === true) {
      throw observability.hardFailure();
    }

    const batch = selectReadyBatch(ready, maxConcurrency, builtInMetadata);
    preflightLocks(batch, scheduleState, lockManager, builtInMetadata);
    const settled = await Promise.allSettled(
      batch.map(async (node) => await runOneNode(node))
    );
    let hardError: unknown;

    for (const [index, result] of settled.entries()) {
      const node = batch[index];

      if (result.status === "fulfilled") {
        const { output, capturedWorkspace } = result.value;

        if (capturedWorkspace !== undefined) {
          if (workspace !== undefined) {
            const failure = schedulerStepFailed(
              node.id,
              duplicateWorkspaceError(node.id)
            );
            steps[node.id] = failure;
            scheduleState.steps[node.id] = failure;
            blocked.add(node.id);
            pending.delete(node.id);
            recordFailedStep(summary, {
              stepId: node.id,
              code: failure.details.cause_code ?? failure.code,
              message: failure.message
            });

            await emitSchedulerEvent("error", "luna.scheduler.step.failed", {
              step_id: node.id,
              node_type: node.type,
              status: "failed",
              error: {
                code: failure.code,
                cause_code: failure.details.cause_code,
                message: failure.message
              }
            });
            continue;
          }

          workspace = capturedWorkspace;
          scheduleState.workspace = capturedWorkspace;
        }

        steps[node.id] = output;
        scheduleState.steps[node.id] = output;
        completed.add(node.id);
        pending.delete(node.id);

        continue;
      }

      const cause = result.reason;
      if (
        errorCode(cause) === "lock_resource_missing" ||
        errorCode(cause) === "lock_manager_missing"
      ) {
        hardError ??= cause;
        continue;
      }

      const failure = schedulerStepFailed(node.id, cause);
      steps[node.id] = failure;
      scheduleState.steps[node.id] = failure;
      blocked.add(node.id);
      pending.delete(node.id);
      recordFailedStep(summary, {
        stepId: node.id,
        code: failure.details.cause_code ?? failure.code,
        message: failure.message
      });

      await emitSchedulerEvent("error", "luna.scheduler.step.failed", {
        step_id: node.id,
        node_type: node.type,
        status: "failed",
        error: {
          code: failure.code,
          cause_code: failure.details.cause_code,
          message: failure.message
        }
      });
    }

    if (hardError !== undefined) {
      throw hardError;
    }
  }

  return {
    status: blocked.size > 0 ? "failed" : "success",
    steps,
    ...(workspace === undefined ? {} : { workspace })
  };
}
