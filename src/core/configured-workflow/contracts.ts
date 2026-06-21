import type { ArtifactStore } from "../artifact-store.js";
import type { JsonValue } from "../json-value.js";
import type { LunaEvent } from "../observability/events.js";
import type { LunaObservability } from "../observability/luna-observability.js";
import type { RunIdentityOptions } from "../run-identity.js";
import type {
  ErrorArtifact,
  Invocation,
  RunIdentity,
  WorkspaceRecord
} from "../types.js";
import type { WorkflowDefinition, WorkflowNode } from "../workflow-definition.js";
import type { WorkflowState } from "../workflow-state.js";
import type {
  ConfiguredWorkflowBootstrapConfigs,
  ConfiguredWorkflowBootstrapOptions,
  ConfiguredWorkflowBootstrapResult
} from "./bootstrap.js";
import type {
  ConfiguredWorkflowFailureFinalizationOptions,
  ConfiguredWorkflowSuccessFinalizationOptions
} from "./finalization.js";
import type { WorkflowNodeRuntimeContext } from "./node-runner.js";

export type RuntimeRunRef = {
  runtimeRunId: string;
};

export type ConfiguredWorkflowBootstrap = {
  bootstrap(
    options: ConfiguredWorkflowBootstrapOptions
  ): Promise<ConfiguredWorkflowBootstrapResult>;
};

export type ConfiguredWorkflowRunner = {
  run(options: {
    invocation: Invocation;
    runtimeRunId?: string;
  }): Promise<ConfiguredWorkflowResult>;
};

export type ConfiguredWorkflowSuccessResult = {
  status: "success";
  run: RunIdentity;
  workflow_id: string;
  steps: Record<string, unknown>;
  report?: JsonValue;
  workspace?: WorkspaceRecord;
};

export type ConfiguredWorkflowFailureResult = {
  status: "failed";
  run: RunIdentity;
  workflow_id?: string;
  error: ErrorArtifact;
  workspace?: WorkspaceRecord;
};

export type ConfiguredWorkflowResult =
  | ConfiguredWorkflowSuccessResult
  | ConfiguredWorkflowFailureResult;

export type ConfiguredWorkflowNodeRunner = {
  runNode(options: {
    node: WorkflowNode;
    state: WorkflowState;
    context: WorkflowNodeRuntimeContext;
  }): Promise<unknown>;
};

export type ConfiguredWorkflowFinalizer = {
  finalizeSuccessWorkspace(
    options: ConfiguredWorkflowSuccessFinalizationOptions
  ): Promise<WorkspaceRecord | undefined>;
  finalizeFailureWorkspace(
    options: ConfiguredWorkflowFailureFinalizationOptions
  ): Promise<WorkspaceRecord | undefined>;
};

export type FailureArtifactWriteOptions = RuntimeRunRef & {
  artifactStore?: ArtifactStore;
  run?: RunIdentity;
  invocation: Invocation;
  workflowId?: string;
  attempt: number;
  date: Date;
  nonce: string;
  error: unknown;
};

export type FailureArtifactWriteResult = RuntimeRunRef & {
  artifactStore: ArtifactStore;
  run: RunIdentity;
  workflowId: string;
  error: ErrorArtifact;
  artifactWriteError?: unknown;
};

export type FailureArtifactWriterDependencies = {
  Store: typeof ArtifactStore;
  configs: ConfiguredWorkflowBootstrapConfigs;
  makeRunIdentity: (
    invocation: Invocation,
    options: RunIdentityOptions
  ) => RunIdentity;
};

export type FailureArtifactWriter = {
  writeFailure(
    options: FailureArtifactWriteOptions
  ): Promise<FailureArtifactWriteResult>;
};

export type RunLockPort = {
  acquire(options: RuntimeRunRef & { resource: string }): Promise<
    RuntimeRunRef & {
      release(): Promise<void>;
    }
  >;
  heartbeat(options: RuntimeRunRef): Promise<string>;
};

export type ObservabilityPort = {
  emit(options: RuntimeRunRef & { event: LunaEvent }): Promise<void>;
};

export type ObservabilityPortFactory = (
  observability: LunaObservability
) => ObservabilityPort;
