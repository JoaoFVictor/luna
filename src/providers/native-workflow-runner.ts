import path from "node:path";
import { officialCapabilityRegistry } from "../capabilities/registry.js";
import { createObservabilitySummary } from "../core/observability/summary.js";
import type { JsonValue } from "../core/runtime/json.js";
import {
  createLangGraphWorkflowRuntimeRunner
} from "../runtime/langgraph/workflow-runner.js";
import { registerConfiguredPiOAuthProviders } from "../agent-runtimes/pi/auth.js";
import { piAgentRuntimeFactory } from "../agent-runtimes/pi/factory.js";
import {
  createRuntimeCompositionForWorkflow
} from "../runtime/composition/runtime-composition.js";
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

export { compileNativeWorkflow } from "./native-run-context.js";
export type { NativeCompiledWorkflow } from "./native-run-context.js";

export async function runNativeWorkflowTarget(input: NativeWorkflowRunInput): Promise<void> {
  const {
    app,
    agentsRoot,
    workflow,
    nativeWorkflow,
    repository,
    run,
    runtimeConfig
  } = await loadNativeRunContext(input);

  if (runtimeConfig.agent_runtime.id === "pi" && workflowUsesAgents(workflow)) {
    await registerConfiguredPiOAuthProviders({ configRoot: input.configRoot });
  }

  const composition = createRuntimeCompositionForWorkflow(
    runtimeConfig,
    nativeWorkflow.workflow,
    {
      capabilityRegistry: officialCapabilityRegistry,
      agentRuntimeFactories: { [piAgentRuntimeFactory.id]: piAgentRuntimeFactory }
    }
  );
  const observabilitySummary = createObservabilitySummary({
    runId: run.run_id,
    workflowId: nativeWorkflow.workflow.id
  });
  const executors = buildNativeWorkflowExecutors({
    app,
    projectRoot: input.projectRoot,
    run
  });
  const workflowRuntime = createLangGraphWorkflowRuntimeRunner();

  await workflowRuntime.run({
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
    langGraphCheckpointer: composition.langGraphCheckpointer,
    artifactPublisher: composition.artifactPublisherForRun(run),
    agentInputs: await buildNativeWorkflowAgentInputs({
      workflow: nativeWorkflow.workflow,
      agentsRoot,
      repository,
      configRoot: input.configRoot
    })
  });
}
