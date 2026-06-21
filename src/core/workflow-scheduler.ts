import type {
  BuiltInStepMetadata,
  ImplementationLifecycleOutcome
} from "./built-ins/index.js";
import {
  initialImplementationLifecycleEvidence,
  recordWorkflowNodeLifecycle,
  type ImplementationLifecycleEvidence
} from "./implementation-lifecycle.js";
import {
  stepFailedEvent,
  stepSkippedEvent,
  stepStartedEvent,
  stepSucceededEvent,
  type LunaObservability
} from "./observability/luna-observability.js";
import { sanitizeJsonObject } from "./observability/sanitize.js";
import {
  recordFailedStep,
  type ObservabilitySummary
} from "./observability/summary.js";
import {
  selectReadyBatchWithPolicy,
  type WorkflowExecutionLocks,
  type WorkflowExecutionPlanItem
} from "./workflow-execution-policy.js";
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
  primaryFailure?: SchedulerStepFailure;
  workspace?: SchedulerWorkflowState["workspace"];
  lifecycleEvidence: ImplementationLifecycleEvidence;
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

async function withLocks<T>(
  state: SchedulerWorkflowState,
  locks: WorkflowExecutionLocks,
  lockManager: SchedulerLockManager | undefined,
  run: () => Promise<T>
): Promise<T> {
  const releases: (() => Promise<void>)[] = [];
  let operationError: unknown;

  try {
    for (const lock of locks) {
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

function preflightExecutionPolicy(
  batch: WorkflowExecutionPlanItem[],
  state: SchedulerWorkflowState,
  lockManager: SchedulerLockManager | undefined
): void {
  const batchExclusionKeys = new Set<string>();

  for (const item of batch) {
    for (const key of item.decision.batchExclusionKeys) {
      if (batchExclusionKeys.has(key)) {
        throw schedulerError(
          "Workflow execution policy produced duplicate batch exclusion keys",
          "workflow_execution_policy_invalid"
        );
      }

      batchExclusionKeys.add(key);
    }

    for (const lock of item.decision.locks) {
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
  let primaryFailure: SchedulerStepFailure | undefined;
  let workspace = state.workspace;
  let lifecycleEvidence =
    state.lifecycleEvidence ?? initialImplementationLifecycleEvidence();
  const scheduleState: SchedulerWorkflowState = {
    ...state,
    steps: { ...state.steps },
    lifecycleEvidence,
    ...(workspace === undefined ? {} : { workspace })
  };

  async function emitStepEvent(
    buildEvent: (
      activeObservability: LunaObservability
    ) => Parameters<LunaObservability["emit"]>[0]
  ): Promise<void> {
    if (observability === undefined) {
      return;
    }

    try {
      await observability.emit(buildEvent(observability));
    } catch (error) {
      if (observability.isHardFailed()) {
        throw error;
      }
    }
  }

  async function emitStepStarted(node: WorkflowNode): Promise<void> {
    await emitStepEvent((activeObservability) =>
      stepStartedEvent({
        ...activeObservability.eventContext("info"),
        step: { id: node.id, type: node.type }
      })
    );
  }

  async function emitStepSucceeded(
    node: WorkflowNode,
    durationMs: number
  ): Promise<void> {
    await emitStepEvent((activeObservability) =>
      stepSucceededEvent({
        ...activeObservability.eventContext("info"),
        step: { id: node.id, type: node.type },
        data: sanitizeJsonObject({ duration_ms: durationMs })
      })
    );
  }

  async function emitStepFailed({
    node,
    durationMs,
    error
  }: {
    node: WorkflowNode;
    durationMs?: number;
    error: unknown;
  }): Promise<void> {
    const errorCode = (error as { code?: unknown } | undefined)?.code;
    const code = typeof errorCode === "string" ? errorCode : undefined;

    await emitStepEvent((activeObservability) =>
      stepFailedEvent({
        ...activeObservability.eventContext("error"),
        step: { id: node.id, type: node.type },
        code,
        data: sanitizeJsonObject({ duration_ms: durationMs, error })
      })
    );
  }

  async function emitStepSkipped(
    node: WorkflowNode,
    error: unknown
  ): Promise<void> {
    const errorCode = (error as { code?: unknown } | undefined)?.code;
    const code = typeof errorCode === "string" ? errorCode : undefined;

    await emitStepEvent((activeObservability) =>
      stepSkippedEvent({
        ...activeObservability.eventContext("warn"),
        step: { id: node.id, type: node.type },
        code,
        data: sanitizeJsonObject({ error })
      })
    );
  }

  async function runOneNode(item: WorkflowExecutionPlanItem): Promise<{
    node: WorkflowNode;
    output: unknown;
    lifecycleOutcome?: ImplementationLifecycleOutcome;
    capturedWorkspace?: SchedulerWorkflowState["workspace"];
  }> {
    const { node, decision } = item;
    const startedAt = Date.now();
    await emitStepStarted(node);

    try {
      const snapshot = snapshotState(scheduleState);
      const output = await withLocks(
        snapshot,
        decision.locks,
        lockManager,
        async () =>
          await runNode({
            node,
            state: snapshot
          })
      );
      const metadata = builtInMetadata(node);
      const lifecycleOutcome =
        node.type === "built_in"
          ? metadata.implementationLifecycleOutcome?.(output)
          : undefined;
      const capturedWorkspace =
        decision.capturesWorkspace && isWorkspaceRecord(output)
          ? output
          : undefined;

      if (decision.capturesWorkspace && workspace !== undefined) {
        throw duplicateWorkspaceError(node.id);
      }

      await writePlannedArtifacts(node, output, scheduleState);
      try {
        await emitStepSucceeded(node, Date.now() - startedAt);
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
        ...(lifecycleOutcome === undefined ? {} : { lifecycleOutcome }),
        ...(capturedWorkspace === undefined ? {} : { capturedWorkspace })
      };
    } catch (error) {
      await emitStepFailed({
        node,
        durationMs: Date.now() - startedAt,
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
        lifecycleEvidence = recordWorkflowNodeLifecycle(
          lifecycleEvidence,
          builtInMetadata(node),
          { status: "skipped" }
        );
        scheduleState.lifecycleEvidence = lifecycleEvidence;
        blocked.add(node.id);
        pending.delete(node.id);
        skippedDependency = true;
        recordFailedStep(summary, {
          stepId: node.id,
          code: skipped.code,
          message: "Workflow dependency failed"
        });
        await emitStepSkipped(node, {
          code: skipped.code,
          message: "Workflow dependency failed"
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

    const batchPlan = selectReadyBatchWithPolicy({
      ready,
      maxConcurrency: execution.max_concurrency,
      builtInMetadata
    });
    preflightExecutionPolicy(batchPlan.items, scheduleState, lockManager);
    const settled = await Promise.allSettled(
      batchPlan.items.map(async (item) => await runOneNode(item))
    );
    let hardError: unknown;

    for (const [index, result] of settled.entries()) {
      const item = batchPlan.items[index];
      const node = item.node;

      if (result.status === "fulfilled") {
        const { output, lifecycleOutcome, capturedWorkspace } = result.value;

        if (capturedWorkspace !== undefined) {
          if (workspace !== undefined) {
            const failure = schedulerStepFailed(
              node.id,
              duplicateWorkspaceError(node.id)
            );
            steps[node.id] = failure;
            scheduleState.steps[node.id] = failure;
            primaryFailure ??= failure;
            blocked.add(node.id);
            pending.delete(node.id);
            recordFailedStep(summary, {
              stepId: node.id,
              code: failure.details.cause_code ?? failure.code,
              message: failure.message
            });

            await emitStepFailed({
              node,
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
        lifecycleEvidence = recordWorkflowNodeLifecycle(
          lifecycleEvidence,
          builtInMetadata(node),
          {
            status: "succeeded",
            ...(lifecycleOutcome === undefined ? {} : { outcome: lifecycleOutcome })
          }
        );
        scheduleState.lifecycleEvidence = lifecycleEvidence;
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
      primaryFailure ??= failure;
      lifecycleEvidence = recordWorkflowNodeLifecycle(
        lifecycleEvidence,
        builtInMetadata(node),
        { status: "failed" }
      );
      scheduleState.lifecycleEvidence = lifecycleEvidence;
      blocked.add(node.id);
      pending.delete(node.id);
      recordFailedStep(summary, {
        stepId: node.id,
        code: failure.details.cause_code ?? failure.code,
        message: failure.message
      });

      await emitStepFailed({
        node,
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

  Object.assign(state.steps, steps);
  state.lifecycleEvidence = lifecycleEvidence;
  if (workspace !== undefined) {
    state.workspace = workspace;
  }

  return {
    status: blocked.size > 0 ? "failed" : "success",
    steps,
    lifecycleEvidence,
    ...(primaryFailure === undefined ? {} : { primaryFailure }),
    ...(workspace === undefined ? {} : { workspace })
  };
}
