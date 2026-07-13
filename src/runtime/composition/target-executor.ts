import path from "node:path";
import { resolveConfigRoot } from "../../core/config/loader.js";
import type { JsonValue } from "../../core/runtime/json.js";
import { assertCheckpointJsonValue } from "../../core/runtime/json.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { Invocation, RouteTarget } from "../../core/router/invocation.js";
import type { CompiledWorkflow } from "../../core/workflow/compiler.js";
import type { WorkflowExecutionScope } from "../../core/workflow/execution-scope.js";
import type {
  WorkflowLifecycleProjectionErrorObserver,
  WorkflowNodeLifecycleObserver
} from "../../core/workflow/events.js";
import type { WorkflowPrecompletedSteps } from "../../core/workflow/execution-contracts.js";

export type TargetExecutorInput = {
  invocation: Invocation;
  target: RouteTarget;
};

export type TargetExecutor = {
  execute(input: TargetExecutorInput): Promise<number>;
};

export type NativeWorkflowRunInput = Omit<TargetExecutorInput, "invocation"> & {
  /** External invocations use the normalized envelope; composed workflows may use any schema-valid JSON input. */
  readonly invocation: JsonValue;
  readonly projectRoot: string;
  readonly configRoot: string;
  /**
   * Optional immutable definition roots. Operational state (artifacts,
   * workspaces, locks, and credentials) still belongs to `projectRoot`.
   */
  readonly definitionRoots?: {
    readonly projectRoot: string;
    readonly configRoot: string;
  };
  /** A control-plane allocated identity that must be used verbatim. */
  readonly run?: RunHandle;
  /** A validated, pinned workflow config supplied by the control plane. */
  readonly workflowConfig?: JsonValue;
  /** Optional bounded execution scope. Omitted means the complete workflow. */
  readonly executionScope?: WorkflowExecutionScope;
  /** Development-only cut points passed to the canonical workflow runtime. */
  readonly precompleted_steps?: WorkflowPrecompletedSteps;
  /** Control-plane lease cancellation propagated into runtime work. */
  readonly signal?: AbortSignal;
  /**
   * An internal durability barrier invoked with the workflow compiled from
   * `definitionRoots`. The native runtime does not start until it resolves.
   */
  readonly onCompiledWorkflow?: (
    compiled: CompiledWorkflow
  ) => Promise<void>;
  /**
   * Internal control-plane terminal durability barrier. It resolves before
   * the runtime succeeded checkpoint.
   */
  readonly onSucceededState?: (state: LunaRuntimeState) => Promise<void>;
  /**
   * Internal, best-effort observation of an exact failed runtime state. This
   * never replaces or suppresses the runtime error.
   */
  readonly onFailedState?: (state: LunaRuntimeState) => void;
  /** Authoritative durability barrier immediately before node execution. */
  readonly onBeforeNodeExecution?: (
    input: { readonly node_id: string; readonly attempt: number }
  ) => Promise<void>;
  /** Ordered control-plane projection of runtime node lifecycle events. */
  readonly onLifecycleEvent?: WorkflowNodeLifecycleObserver;
  /** Best-effort notification that lifecycle projection degraded. */
  readonly onLifecycleProjectionError?: WorkflowLifecycleProjectionErrorObserver;
};

export type NativeWorkflowRunner = (
  input: NativeWorkflowRunInput
) => Promise<unknown>;

export type LunaTargetExecutorDependencies = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly runWorkflow: NativeWorkflowRunner;
};

export function createLunaTargetExecutor({
  projectRoot,
  configRoot,
  runWorkflow
}: LunaTargetExecutorDependencies): TargetExecutor {
  return {
    async execute(input) {
      if (input.target.type !== "workflow") {
        throw runtimeError(
          "Target executor only supports workflow targets",
          "runtime_state_invalid",
          { details: { target: input.target } }
        );
      }

      const invocation: unknown = input.invocation;
      assertCheckpointJsonValue(invocation, "$.invocation");
      await runWorkflow({
        ...input,
        invocation,
        projectRoot,
        configRoot
      });
      return 0;
    }
  };
}

export function resolveRuntimeConfigRoot(
  projectRoot: string,
  env: { LUNA_CONFIG_ROOT?: string } = process.env
): string {
  const configured = resolveConfigRoot(env);
  return path.isAbsolute(configured)
    ? configured
    : path.join(projectRoot, configured);
}
