import type {
  AgentRuntimeEventSink,
  AgentRuntimePort,
  AgentRuntimeRequirement
} from "../agent-runtime/contracts.js";
import type { BuiltInStepMetadata } from "../built-ins/types.js";
import type { ModelProfile } from "../config/schemas.js";
import type { ObservabilitySummary } from "../observability/summary.js";
import type { ArtifactOverwritePolicy } from "../runtime/artifacts/transaction.js";
import type { RuntimeBackends } from "../runtime/backends/contracts.js";
import type { JsonValue } from "../runtime/json.js";
import type { RunHandle } from "../runtime/run-handle.js";
import type { LunaRuntimeState } from "../runtime/state.js";
import type { ResolvedToolCatalog } from "../tools/resolved-catalog.js";
import type { CompiledWorkflow, CompiledWorkflowNode } from "./compiler.js";
import type { WorkflowDefinition } from "./definition-types.js";
import type { WorkflowLockManager } from "./runner-locks.js";
import type { WorkflowRuntimeContext } from "./runtime-context.js";

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
    readonly format: "json" | "markdown";
    readonly value: unknown;
    readonly overwrite_policy: ArtifactOverwritePolicy;
  }): Promise<WorkflowArtifactRef>;
};

export type WorkflowWorkspaceLifecyclePort = {
  complete(input: {
    readonly status: "succeeded" | "failed";
    readonly state: LunaRuntimeState;
    readonly runtimeContext: WorkflowRuntimeContext;
  }): Promise<unknown | undefined> | unknown | undefined;
};

export type WorkflowBuiltInExecutor = (input: {
  readonly node: CompiledWorkflowNode;
  readonly input: unknown;
  readonly state: LunaRuntimeState;
  readonly runtimeContext: WorkflowRuntimeContext;
  readonly workflow: WorkflowDefinition;
  readonly observabilitySummary?: ObservabilitySummary;
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
  readonly observabilitySummary?: ObservabilitySummary;
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

export type RunWorkflowInput = {
  readonly compiled: CompiledWorkflow;
  readonly workflow: WorkflowDefinition;
  readonly invocation: JsonValue;
  readonly config: JsonValue;
  readonly run: RunHandle;
  readonly runtimeContext?: WorkflowRuntimeContext;
  readonly backends: RuntimeBackends;
  readonly builtIns: Record<string, WorkflowBuiltInExecutor>;
  readonly patternExecutors?: Record<string, WorkflowPatternExecutor>;
  readonly builtInMetadata?: WorkflowBuiltInMetadataResolver;
  readonly lockManager?: WorkflowLockManager;
  readonly agentRuntime: AgentRuntimePort;
  readonly agentInputs?: WorkflowAgentInputMap;
  readonly artifactPublisher?: WorkflowArtifactPublisherPort;
  readonly observabilitySummary?: ObservabilitySummary;
  readonly workspaceLifecycle?: WorkflowWorkspaceLifecyclePort;
};

export type ResumeWorkflowInput = {
  readonly compiled: CompiledWorkflow;
  readonly workflow: WorkflowDefinition;
  readonly runtimeContext?: WorkflowRuntimeContext;
  readonly backends: RuntimeBackends;
  readonly builtIns: Record<string, WorkflowBuiltInExecutor>;
  readonly patternExecutors?: Record<string, WorkflowPatternExecutor>;
  readonly builtInMetadata?: WorkflowBuiltInMetadataResolver;
  readonly lockManager?: WorkflowLockManager;
  readonly agentRuntime: AgentRuntimePort;
  readonly agentInputs?: WorkflowAgentInputMap;
  readonly artifactPublisher?: WorkflowArtifactPublisherPort;
  readonly observabilitySummary?: ObservabilitySummary;
  readonly workspaceLifecycle?: WorkflowWorkspaceLifecyclePort;
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
