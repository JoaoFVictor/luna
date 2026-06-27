import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type {
  AgentRuntimePort,
  AgentRuntimeEventSink,
  AgentRuntimeRequirement
} from "../../core/agent-runtime/contracts.js";
import type { ObservabilitySummary } from "../../core/observability/summary.js";
import type { BuiltInStepMetadata } from "../../core/built-ins/types.js";
import type { ModelProfile } from "../../core/config/schemas.js";
import type { RuntimeBackends } from "../../core/runtime/backends/contracts.js";
import type { ArtifactPublisherPort } from "../../capabilities/artifacts/publisher.js";
import type { JsonValue } from "../../core/runtime/json.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type { ResolvedToolCatalog } from "../../core/tools/resolved-catalog.js";
import type { CompiledWorkflow, CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";
import type { WorkflowLockManager } from "../../core/workflow/runner-locks.js";
import type { WorkflowRuntimeContext } from "../../core/workflow/runtime-context.js";

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

export type WorkflowAgentDefaults = {
  readonly instructions: string;
  readonly model_profile: ModelProfile;
  readonly tools: ResolvedToolCatalog;
  readonly runtime_requirements?: readonly AgentRuntimeRequirement[];
  readonly context: unknown;
  readonly output_schema?: unknown;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly events?: AgentRuntimeEventSink;
};

export type WorkflowAgentInputMap = Readonly<Record<string, WorkflowAgentDefaults>>;

export type RunCompiledWorkflowInput = {
  readonly compiled: CompiledWorkflow;
  readonly workflow: WorkflowDefinition;
  readonly invocation: JsonValue;
  readonly config: JsonValue;
  readonly run: RunHandle;
  readonly runtimeContext?: WorkflowRuntimeContext;
  readonly backends: RuntimeBackends;
  readonly builtIns: Record<string, WorkflowBuiltInExecutor>;
  readonly builtInMetadata?: WorkflowBuiltInMetadataResolver;
  readonly lockManager?: WorkflowLockManager;
  readonly agentRuntime: AgentRuntimePort;
  readonly agentInputs?: WorkflowAgentInputMap;
  readonly langGraphCheckpointer?: BaseCheckpointSaver;
  readonly artifactPublisher?: ArtifactPublisherPort;
  readonly observabilitySummary?: ObservabilitySummary;
};

export type ResumeCompiledWorkflowInput = Omit<
  RunCompiledWorkflowInput,
  "invocation" | "config" | "run"
> & {
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
