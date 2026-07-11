import path from "node:path";
import {
  assertCheckpointJsonValue
} from "../../core/runtime/json.js";
import type { JsonValue } from "../../core/runtime/json.js";
import { loadYamlFile } from "../../core/config/loader.js";
import {
  AppConfigSchema,
  RepositoriesConfigSchema,
  type AppConfig,
  type RepositoryConfig
} from "../../core/config/schemas.js";
import { InvocationSchema } from "../../core/router/invocation.js";
import { runtimeError } from "../../core/runtime/errors.js";
import { resumeContextFromMetadata } from "../../runtime/workflow/interrupts.js";
import type { WorkflowDefinition } from "../../core/workflow/definition-types.js";
import type { RunHandle } from "../../core/runtime/run-handle.js";
import {
  createRuntimeCompositionForWorkflow
} from "../../runtime/composition/runtime-composition.js";
import type { RuntimeCompositionConfig } from "../../runtime/composition/app-config.js";
import type { ChangeRequestProviderFactory } from "../../capabilities/change-request/contracts.js";
import type { PullRequestReviewProviderFactory } from "../../capabilities/pull-request-review/contracts.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput,
  WorkflowRunResult
} from "../../core/workflow/execution-contracts.js";
import type {
  NativeWorkflowRunInput
} from "../../runtime/composition/target-executor.js";
import type { RouteTarget } from "../../core/router/invocation.js";
import { resolveRepository } from "../../core/workflow/workspace-resolver.js";
import { buildNativeWorkflowAgentInputs } from "./native-agent-inputs.js";
import {
  compileNativeWorkflow,
  loadNativeRunContext,
  loadNativeWorkflowDefinition,
  loadWorkflowRuntimeConfig,
  runtimeCompositionConfig,
  workflowUsesAgents
} from "./native-run-context.js";
import type { NativeCompiledWorkflow } from "./native-run-context.js";
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
    | "pullRequestReviewProviderFactories"
    | "capabilityRegistry"
    | "capabilityManifests"
  >;
  readonly changeRequestProviderFactories?: readonly ChangeRequestProviderFactory[];
  readonly pullRequestReviewProviderFactories?: readonly PullRequestReviewProviderFactory[];
};

export type NativeWorkflowResumeInput = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly target: RouteTarget;
  readonly thread_id: string;
  readonly checkpoint_id: string;
  readonly interrupt_id: string;
  readonly decision: JsonValue;
};

export async function runNativeWorkflowTarget(
  input: NativeWorkflowRunInput,
  dependencies: NativeWorkflowTargetDependencies = {}
): Promise<WorkflowRunResult> {
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
  const invocation = input.invocation;
  assertCheckpointJsonValue(invocation);
  const execution = await prepareNativeWorkflowExecution({
    platform,
    dependencies,
    projectRoot: input.projectRoot,
    configRoot: input.configRoot,
    app,
    agentsRoot,
    workflow,
    nativeWorkflow,
    repository,
    run,
    runtimeConfig
  });

  const workflowRuntimeInput = {
    compiled: nativeWorkflow.compiled,
    workflow: nativeWorkflow.workflow,
    invocation,
    config: await loadWorkflowRuntimeConfig({
      workflow: nativeWorkflow.workflow,
      configRoot: input.configRoot
    }),
    run,
    ...execution.input
  } satisfies RunWorkflowInput;

  return await execution.composition.workflowRuntime.run(workflowRuntimeInput);
}

export async function resumeNativeWorkflowTarget(
  input: NativeWorkflowResumeInput,
  dependencies: NativeWorkflowTargetDependencies = {}
): Promise<WorkflowRunResult> {
  const platform = dependencies.platform ?? nativeLunaPlatformRegistrations;
  const app = await loadYamlFile(path.join(input.configRoot, "app.yaml"), AppConfigSchema);
  const repositories = await loadYamlFile(
    path.join(input.configRoot, "repositories.yaml"),
    RepositoriesConfigSchema
  );
  const agentsRoot = path.join(input.projectRoot, "agents");
  const definition = await loadNativeWorkflowDefinition({
    projectRoot: input.projectRoot,
    workflowId: input.target.id,
    platform
  });
  const nativeWorkflow = await compileNativeWorkflow({
    workflow: definition,
    agentsRoot,
    platform
  });
  const runtimeConfig = runtimeCompositionConfig(app, input.projectRoot);
  const composition = createRuntimeCompositionForWorkflow(
    runtimeConfig,
    nativeWorkflow.workflow,
    {
      capabilityRegistry: platform.capabilityRegistry,
      workflowRuntimeFactories: platform.workflowRuntimeFactories,
      agentRuntimeFactories: platform.agentRuntimeFactories
    }
  );
  const checkpoint = await composition.backends.checkpoints.load(input.thread_id, {
    checkpointId: input.checkpoint_id
  });
  if (checkpoint === undefined) {
    throw runtimeError("Checkpoint not found", "runtime_interrupt_not_found", {
      details: { checkpoint_id: input.checkpoint_id, thread_id: input.thread_id }
    });
  }
  const resumeContext = resumeContextFromMetadata(checkpoint.metadata);
  const invocation = InvocationSchema.parse(resumeContext.invocation);
  const repository = nativeWorkflow.workflow.requires.repository
    ? resolveRepository(invocation, repositories.repositories)
    : undefined;

  const execution = await prepareNativeWorkflowExecution({
    platform,
    dependencies,
    projectRoot: input.projectRoot,
    configRoot: input.configRoot,
    app,
    agentsRoot,
    workflow: definition,
    nativeWorkflow,
    repository,
    run: resumeContext.run,
    runtimeConfig,
    composition
  });
  const workflowRuntimeInput = {
    compiled: nativeWorkflow.compiled,
    workflow: nativeWorkflow.workflow,
    ...execution.input,
    thread_id: input.thread_id,
    checkpoint_id: input.checkpoint_id,
    interrupt_id: input.interrupt_id,
    decision: input.decision
  } satisfies ResumeWorkflowInput;

  return await execution.composition.workflowRuntime.resume(workflowRuntimeInput);
}

async function prepareNativeWorkflowExecution({
  platform,
  dependencies,
  projectRoot,
  configRoot,
  app,
  agentsRoot,
  workflow,
  nativeWorkflow,
  repository,
  run,
  runtimeConfig,
  composition = createRuntimeCompositionForWorkflow(
    runtimeConfig,
    nativeWorkflow.workflow,
    {
      capabilityRegistry: platform.capabilityRegistry,
      workflowRuntimeFactories: platform.workflowRuntimeFactories,
      agentRuntimeFactories: platform.agentRuntimeFactories
    }
  )
}: {
  readonly platform: NonNullable<NativeWorkflowTargetDependencies["platform"]>;
  readonly dependencies: NativeWorkflowTargetDependencies;
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly app: AppConfig;
  readonly agentsRoot: string;
  readonly workflow: WorkflowDefinition;
  readonly nativeWorkflow: NativeCompiledWorkflow;
  readonly repository?: RepositoryConfig;
  readonly run: RunHandle;
  readonly runtimeConfig: RuntimeCompositionConfig;
  readonly composition?: ReturnType<typeof createRuntimeCompositionForWorkflow>;
}): Promise<{
  readonly composition: ReturnType<typeof createRuntimeCompositionForWorkflow>;
  readonly input: Pick<
    RunWorkflowInput,
    | "runtimeContext"
    | "backends"
    | "builtIns"
    | "patternExecutors"
    | "builtInMetadata"
    | "lockManager"
    | "workspaceLifecycle"
    | "agentRuntime"
    | "observability"
    | "artifactPublisher"
    | "agentInputs"
  >;
}> {
  await platform.agentRuntimeFactories[runtimeConfig.agent_runtime.id]?.prepare?.({
    projectRoot,
    configRoot,
    workflow,
    options: runtimeConfig.agent_runtime.options,
    hasAgents: workflowUsesAgents(workflow)
  });
  const executors = buildNativeWorkflowExecutors({
    app,
    projectRoot,
    run,
    changeRequestProviderFactories:
      dependencies.changeRequestProviderFactories ??
      platform.changeRequestProviderFactories,
    pullRequestReviewProviderFactories:
      dependencies.pullRequestReviewProviderFactories ??
      platform.pullRequestReviewProviderFactories,
    workflowBuiltIns: platform.workflowBuiltIns,
    taskProviderBuiltIns: platform.taskProviderBuiltIns,
    patternExecutors: platform.patternExecutors,
    capabilityRegistry: platform.capabilityRegistry
  });

  return {
    composition,
    input: {
      runtimeContext: {
        repository,
        workspaceRoot: path.resolve(projectRoot, app.workspace.root),
        agentsRoot
      },
      backends: composition.backends,
      ...executors,
      agentRuntime: composition.agentRuntime,
      observability: composition.observabilityForRun({
        run,
        workflow: nativeWorkflow.workflow
      }),
      artifactPublisher: composition.artifactPublisherForRun(run),
      agentInputs: await buildNativeWorkflowAgentInputs({
        workflow: nativeWorkflow.workflow,
        agentsRoot,
        repository,
        configRoot,
        capabilityRegistry: platform.capabilityRegistry
      })
    }
  };
}
