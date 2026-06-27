import path from "node:path";
import { officialCapabilityRegistry } from "../capabilities/registry.js";
import { createObservabilitySummary } from "../core/observability/summary.js";
import type { JsonValue } from "../core/runtime/json.js";
import {
  createRuntimeCompositionForWorkflow
} from "../runtime/composition/runtime-composition.js";
import type {
  AgentRuntimeFactory
} from "../runtime/composition/runtime-composition.js";
import type { ChangeRequestProviderFactory } from "../core/change-request/contracts.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput,
  WorkflowRunResult
} from "../core/workflow/execution-contracts.js";
import type { WorkflowRuntimeFactory } from "../core/workflow/runner-port.js";
import type {
  NativeWorkflowRunInput
} from "../runtime/composition/target-executor.js";
import { buildNativeWorkflowAgentInputs } from "./native-agent-inputs.js";
import {
  loadNativeRunContext,
  loadWorkflowRuntimeConfig,
  workflowUsesAgents
} from "./native-run-context.js";
import { buildNativeWorkflowExecutors } from "./native-workflow-executors.js";
import {
  nativeAgentRuntimeFactories,
  nativeWorkflowRuntimeFactories
} from "./native-runtime-factories.js";

export { compileNativeWorkflow } from "./native-run-context.js";
export type { NativeCompiledWorkflow } from "./native-run-context.js";

export type NativeWorkflowTargetDependencies = {
  readonly workflowRuntimeFactories?: Readonly<Record<
    string,
    WorkflowRuntimeFactory<RunWorkflowInput, ResumeWorkflowInput, WorkflowRunResult>
  >>;
  readonly agentRuntimeFactories?: Readonly<Record<string, AgentRuntimeFactory>>;
  readonly changeRequestProviderFactories?: readonly ChangeRequestProviderFactory[];
};

export async function runNativeWorkflowTarget(
  input: NativeWorkflowRunInput,
  dependencies: NativeWorkflowTargetDependencies = {}
): Promise<void> {
  const {
    app,
    agentsRoot,
    workflow,
    nativeWorkflow,
    repository,
    run,
    runtimeConfig
  } = await loadNativeRunContext(input);

  const agentRuntimeFactories = {
    ...nativeAgentRuntimeFactories,
    ...(dependencies.agentRuntimeFactories ?? {})
  };
  const workflowRuntimeFactories = {
    ...nativeWorkflowRuntimeFactories,
    ...(dependencies.workflowRuntimeFactories ?? {})
  };

  const composition = createRuntimeCompositionForWorkflow(
    runtimeConfig,
    nativeWorkflow.workflow,
    {
      capabilityRegistry: officialCapabilityRegistry,
      workflowRuntimeFactories,
      agentRuntimeFactories
    }
  );
  await agentRuntimeFactories[runtimeConfig.agent_runtime.id]?.prepare?.({
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
    changeRequestProviderFactories: dependencies.changeRequestProviderFactories
  });
  const workflowRuntimeInput = {
    compiled: nativeWorkflow.compiled,
    workflow: nativeWorkflow.workflow,
    invocation: input.invocation as unknown as JsonValue,
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
      configRoot: input.configRoot
    })
  } satisfies RunWorkflowInput;

  await composition.workflowRuntime.run(workflowRuntimeInput);
}
