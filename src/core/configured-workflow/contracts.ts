import type { Invocation, RunIdentity } from "../types.js";
import type { WorkflowDefinition, WorkflowNode } from "../workflow-definition.js";
import type { WorkflowState } from "../workflow-state.js";

export type RuntimeRunRef = {
  runtimeRunId: string;
};

export type ConfiguredWorkflowBootstrap = {
  bootstrap(options: {
    invocation: Invocation;
    runtimeRunId?: string;
  }): Promise<{
    run: RunIdentity;
    workflow: WorkflowDefinition;
  }>;
};

export type ConfiguredWorkflowRunner = {
  run(options: { invocation: Invocation }): Promise<unknown>;
};

export type ConfiguredWorkflowNodeRunner = {
  runNode(options: {
    node: WorkflowNode;
    state: WorkflowState;
  }): Promise<unknown>;
};

export type ConfiguredWorkflowFinalizer = {
  finalize(
    options: RuntimeRunRef & { status: "success" | "failed" }
  ): Promise<void>;
};

export type FailureArtifactWriter = {
  writeFailure(
    options: RuntimeRunRef & { error: unknown }
  ): Promise<RuntimeRunRef>;
};

export type RunLockPort = {
  acquire(options: RuntimeRunRef & { resource?: string }): Promise<
    RuntimeRunRef & {
      release(): Promise<void>;
    }
  >;
  heartbeat(options: RuntimeRunRef): Promise<string>;
};

export type ObservabilityPort = {
  emit(
    options: RuntimeRunRef & { event: Record<string, unknown> }
  ): Promise<unknown>;
};
