import type {
  AgentRuntimeEventSink,
  AgentRuntimePort,
  AgentRuntimeRequirement
} from "../agent-runtime/contracts.js";
import type { ArtifactSemanticType } from "../artifacts/semantic-type.js";
import type { BuiltInStepMetadata } from "../built-ins/types.js";
import type { ModelProfile } from "../config/schemas.js";
import type { WorkflowObservability } from "../observability/workflow-observability.js";
import type { ArtifactOverwritePolicy } from "../runtime/artifacts/transaction.js";
import type { RuntimeBackends } from "../runtime/backends/contracts.js";
import type { JsonValue } from "../runtime/json.js";
import type { RunHandle } from "../runtime/run-handle.js";
import type { LunaRuntimeState, RuntimeArtifactRef } from "../runtime/state.js";
import type { ResolvedToolCatalog } from "../tools/resolved-catalog.js";
import type { CompiledWorkflow, CompiledWorkflowNode } from "./compiler.js";
import type { WorkflowDefinition } from "./definition-types.js";
import type { WorkflowExecutionScope } from "./execution-scope.js";
import type { WorkflowLockManager } from "./runner-locks.js";
import type { WorkflowRuntimeContext } from "./runtime-context.js";
import type {
  WorkflowLifecycleProjectionErrorObserver,
  WorkflowNodeLifecycleObserver
} from "./events.js";

export type WorkflowArtifactRef = {
  readonly id: string;
  readonly uri: string;
  readonly node_id: string;
  readonly media_type?: string;
};

export type WorkflowArtifactPublisherPort = {
  publish(input: {
    readonly node_id: string;
    readonly path: string;
    readonly format: "json" | "markdown" | "png";
    readonly value: unknown;
    readonly semantic_type?: ArtifactSemanticType;
    readonly overwrite_policy: ArtifactOverwritePolicy;
  }): Promise<WorkflowArtifactRef>;
  verify?(ref: WorkflowArtifactRef & {
    readonly content_hash?: string;
  }): Promise<boolean>;
};

export type WorkflowBuiltInExecutor = (input: {
  readonly node: CompiledWorkflowNode;
  readonly input: unknown;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly workflow: WorkflowDefinition;
  readonly observability?: WorkflowObservability;
}) => Promise<unknown> | unknown;

export type WorkflowBuiltInMetadataResolver = (
  node: CompiledWorkflowNode
) => BuiltInStepMetadata;

export type WorkflowPatternExecutor = (input: {
  readonly workflowInput: RunWorkflowInput;
  readonly node: CompiledWorkflowNode;
  readonly input: unknown;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly workflow: WorkflowDefinition;
  readonly observability?: WorkflowObservability;
}) => Promise<unknown> | unknown;

export type WorkflowCompositionExecutor = (input: {
  readonly workflowInput: RunWorkflowInput;
  readonly node: CompiledWorkflowNode;
  readonly input: JsonValue;
  readonly child: {
    readonly workflow: WorkflowDefinition;
    readonly compiled: CompiledWorkflow;
  };
}) => Promise<unknown> | unknown;

export type WorkflowAgentDefaults = {
  readonly agent: unknown;
  readonly model_profile: ModelProfile;
  readonly tools: ResolvedToolCatalog;
  readonly skill_sources?: unknown;
  readonly runtime_requirements?: readonly AgentRuntimeRequirement[];
  readonly output_schema?: unknown;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly events?: AgentRuntimeEventSink;
};

export type WorkflowAgentInputMap = Readonly<Record<string, WorkflowAgentDefaults>>;

/**
 * Development-only node outputs that are treated as already completed.
 * Production callers must omit this field.
 */
export type WorkflowPrecompletedSteps = Readonly<Record<string, JsonValue>>;

export type RunWorkflowInput = {
  readonly compiled: CompiledWorkflow;
  readonly workflow: WorkflowDefinition;
  readonly invocation: JsonValue;
  readonly config: JsonValue;
  readonly run: RunHandle;
  /** A bounded partial run validates the terminal node output, not the full workflow output schema. */
  readonly executionScope?: WorkflowExecutionScope;
  /** Development-only cut points. Their executors and exclusively-required ancestors do not run. */
  readonly precompleted_steps?: WorkflowPrecompletedSteps;
  /** Internal continuation supplied only by the durable loop resume protocol. */
  readonly loop_resume?: {
    readonly node_id: string;
    readonly iteration: number;
    readonly steps: Record<string, JsonValue>;
    readonly artifact_refs: RuntimeArtifactRef[];
    readonly decision: JsonValue;
  };
  /** Internal continuation persisted when a loop reaches its human gate. */
  readonly loop_continuation?: {
    readonly node_id: string;
    readonly iteration: number;
    readonly steps: Record<string, JsonValue>;
    readonly artifact_refs: RuntimeArtifactRef[];
  };
  readonly signal?: AbortSignal;
  readonly runtimeContext?: WorkflowRuntimeContext;
  readonly backends: RuntimeBackends;
  readonly builtIns: Record<string, WorkflowBuiltInExecutor>;
  readonly patternExecutors?: Record<string, WorkflowPatternExecutor>;
  readonly compositionExecutor?: WorkflowCompositionExecutor;
  readonly builtInMetadata?: WorkflowBuiltInMetadataResolver;
  readonly lockManager?: WorkflowLockManager;
  readonly agentRuntime: AgentRuntimePort;
  readonly agentInputs?: WorkflowAgentInputMap;
  readonly artifactPublisher?: WorkflowArtifactPublisherPort;
  readonly observability?: WorkflowObservability;
  /**
   * Internal durability barrier invoked after final output validation and
   * before the runtime succeeded checkpoint.
   * When present, the control-plane terminal intent is the first success
   * authority and resolves before the runtime may continue.
   */
  readonly onSucceededState?: (state: LunaRuntimeState) => Promise<void>;
  /**
   * Internal, best-effort observation of an exact failed runtime state.
   * The observer is deliberately synchronous and cannot change runtime failure
   * semantics.
   */
  readonly onFailedState?: (state: LunaRuntimeState) => void;
  /**
   * Internal, ordered projection of node lifecycle events at their production
   * boundary. Projection failures are observational and must never change node
   * outcome or retry semantics.
   */
  readonly onLifecycleEvent?: WorkflowNodeLifecycleObserver;
  readonly onLifecycleProjectionError?: WorkflowLifecycleProjectionErrorObserver;
};

export type ResumeWorkflowInput = {
  readonly compiled: CompiledWorkflow;
  readonly workflow: WorkflowDefinition;
  readonly signal?: RunWorkflowInput["signal"];
  readonly runtimeContext?: WorkflowRuntimeContext;
  readonly backends: RuntimeBackends;
  readonly builtIns: Record<string, WorkflowBuiltInExecutor>;
  readonly patternExecutors?: Record<string, WorkflowPatternExecutor>;
  readonly compositionExecutor?: WorkflowCompositionExecutor;
  readonly builtInMetadata?: WorkflowBuiltInMetadataResolver;
  readonly lockManager?: WorkflowLockManager;
  readonly agentRuntime: AgentRuntimePort;
  readonly agentInputs?: WorkflowAgentInputMap;
  readonly artifactPublisher?: WorkflowArtifactPublisherPort;
  readonly observability?: WorkflowObservability;
  readonly onSucceededState?: RunWorkflowInput["onSucceededState"];
  readonly onFailedState?: RunWorkflowInput["onFailedState"];
  readonly onLifecycleEvent?: RunWorkflowInput["onLifecycleEvent"];
  readonly onLifecycleProjectionError?: RunWorkflowInput["onLifecycleProjectionError"];
  readonly thread_id: string;
  readonly checkpoint_id: string;
  readonly interrupt_id: string;
  readonly decision: JsonValue;
};

export type WorkflowRunResult =
  | {
      readonly status: "succeeded";
      readonly output: JsonValue;
      readonly state: LunaRuntimeState;
    }
  | {
      readonly status: "waiting_for_input";
      readonly interrupt_id: string;
      readonly checkpoint_id: string;
      readonly state: LunaRuntimeState;
    };
