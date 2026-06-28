import path from "node:path";
import { createObservabilitySummary } from "../../core/observability/summary.js";
import {
  assertCheckpointJsonValue
} from "../../core/runtime/json.js";
import {
  createRuntimeCompositionForWorkflow
} from "../../runtime/composition/runtime-composition.js";
import type { ChangeRequestProviderFactory } from "../../core/change-request/contracts.js";
import type { RunWorkflowInput } from "../../core/workflow/execution-contracts.js";
import type {
  NativeWorkflowRunInput
} from "../../runtime/composition/target-executor.js";
import { buildNativeWorkflowAgentInputs } from "./native-agent-inputs.js";
import {
  loadNativeRunContext,
  loadWorkflowRuntimeConfig,
  workflowUsesAgents
} from "./native-run-context.js";
import { buildNativeWorkflowExecutors } from "./native-workflow-executors.js";
import {
  nativeLunaPlatformRegistrations,
  type NativeLunaPlatformRegistrations
} from "./native-platform-registrations.js";

export { compileNativeWorkflow } from "./native-run-context.js";
export type { NativeCompiledWorkflow } from "./native-run-context.js";

export type NativeWorkflowTargetDependencies = {
  readonly platform?: Pick<
    NativeLunaPlatformRegistrations,
    | "agentRuntimeFactories"
    | "workflowRuntimeFactories"
    | "workflowBuiltIns"
    | "taskProviderBuiltIns"
    | "patternExecutors"
    | "changeRequestProviderFactories"
    | "capabilityRegistry"
    | "capabilityManifests"
  >;
  readonly changeRequestProviderFactories?: readonly ChangeRequestProviderFactory[];
};

export async function runNativeWorkflowTarget(
  input: NativeWorkflowRunInput,
  dependencies: NativeWorkflowTargetDependencies = {}
): Promise<void> {
  const platform = dependencies.platform ?? nativeLunaPlatformRegistrations;
  const {
    app,
    agentsRoot,
    workflow,
    nativeWorkflow,
    repository,
    run,
    runtimeConfig
  } = await loadNativeRunContext(input, { platform });
  const composition = createRuntimeCompositionForWorkflow(
    runtimeConfig,
    nativeWorkflow.workflow,
    {
      capabilityRegistry: platform.capabilityRegistry,
      workflowRuntimeFactories: platform.workflowRuntimeFactories,
      agentRuntimeFactories: platform.agentRuntimeFactories
    }
  );
  await platform.agentRuntimeFactories[runtimeConfig.agent_runtime.id]?.prepare?.({
    configRoot: input.configRoot,
    workflow,
    options: runtimeConfig.agent_runtime.options,
    hasAgents: workflowUsesAgents(workflow)
  });
  const observabilitySummary = createObservabilitySummary({
    runId: run.run_id,
    workflowId: nativeWorkflow.workflow.id
  });
  const executors = buildNativeWorkflowExecutors({
    app,
    projectRoot: input.projectRoot,
    run,
    changeRequestProviderFactories:
      dependencies.changeRequestProviderFactories ??
      platform.changeRequestProviderFactories,
    workflowBuiltIns: platform.workflowBuiltIns,
    taskProviderBuiltIns: platform.taskProviderBuiltIns,
    patternExecutors: platform.patternExecutors,
    capabilityRegistry: platform.capabilityRegistry
  });
  const invocation = input.invocation;
  assertCheckpointJsonValue(invocation);

  const workflowRuntimeInput = {
    compiled: nativeWorkflow.compiled,
    workflow: nativeWorkflow.workflow,
    invocation,
    config: await loadWorkflowRuntimeConfig({
      workflow: nativeWorkflow.workflow,
      configRoot: input.configRoot
    }),
    run,
    runtimeContext: {
      repository,
      workspaceRoot: path.resolve(input.projectRoot, app.workspace.root),
      agentsRoot
    },
    backends: composition.backends,
    ...executors,
    agentRuntime: composition.agentRuntime,
    observabilitySummary,
    artifactPublisher: composition.artifactPublisherForRun(run),
    agentInputs: await buildNativeWorkflowAgentInputs({
      workflow: nativeWorkflow.workflow,
      agentsRoot,
      repository,
      configRoot: input.configRoot,
      capabilityRegistry: platform.capabilityRegistry
    })
  } satisfies RunWorkflowInput;

  await composition.workflowRuntime.run(workflowRuntimeInput);
}
