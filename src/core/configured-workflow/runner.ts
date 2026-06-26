import path from "node:path";
import { writePlannedArtifacts } from "../workflow/artifact-write-plan.js";
import { ArtifactStore } from "../artifacts/store.js";
import { cleanup as defaultCleanupWorktree } from "../git/worktree-cleanup.js";
import {
  builtInStepRegistry as defaultBuiltInStepRegistry
} from "../built-ins/executor.js";
import type {
  BuiltInStepDependencies,
  BuiltInStepMetadata,
  BuiltInStepRegistryView,
  RunBuiltInStepOptions
} from "../built-ins/types.js";
import { resolveConfigRoot } from "../config/loader.js";
import { assertJsonValue, type JsonValue } from "../json/value.js";
import { routeInvocation as defaultRouteInvocation } from "../router/router.js";
import {
  RunLockManager,
  type RunLockManagerOptions
} from "../workflow/lock-manager.js";
import {
  customEvent,
  runCompletedEvent,
  runStartedEvent,
  type LunaObservability,
  type LunaObservabilitySink
} from "../observability/luna-observability.js";
import { sanitizeJsonObject } from "../observability/sanitize.js";
import {
  writeSummaryBestEffort,
  type ObservabilitySummary
} from "../observability/summary.js";
import {
  runWorkflowSchedule,
  type SchedulerLockManager
} from "../workflow/scheduler.js";
import { splitDeferredFinalReportNodesByPolicy } from "../workflow/execution-policy.js";
import {
  createRunIdentity as defaultCreateRunIdentity,
  type RunIdentityOptions
} from "../invocation/run-identity.js";
import { lifecycleEvidenceFromSchedulerState } from "../write-mode/lifecycle.js";
import {
  defaultWorkflowObservabilityConfig
} from "../workflow/definition.js";
import {
  resolveWorkflowAgentOutputSchema,
  validateWorkflowAgentNodeOutput,
  validateWorkflowNodeOutput
} from "../workflow/definition-validation.js";
import {
  resolveEffectiveSkillReferences,
  type ResolvedSkillReference
} from "../skills/definition.js";
import type { SchedulerWorkflowState } from "../workflow/state.js";
import { resolveRepository as defaultResolveRepository } from "../workflow/workspace-resolver.js";
import {
  cleanupMayRemoveWorktree,
  configuredWorkflowFinalizer,
  withRepositoryCleanupLock
} from "./finalization.js";
import {
  configuredWorkflowError,
  errorCode,
  errorMessage
} from "./errors.js";
import {
  configuredWorkflowNodeRunner,
  type ResolveAgentOutputSchemaOptions,
  type ResolveAgentSkillsOptions,
  type ResolveAgentToolCatalogOptions,
  type RunGatedAgentLoopStepOptions,
  type WorkflowNodeRuntimeContext
} from "./node-runner.js";
import type { AgentRuntimePort } from "../agent-runtime/contracts.js";
import type { ResolvedToolCatalog } from "../tools/resolved-catalog.js";
import {
  configuredWorkflowBootstrap,
  createRunObservability,
  createRunNonce,
  loadConfigs
} from "./bootstrap.js";
import { createFailureArtifactWriter } from "./failure-artifacts.js";
import {
  createObservabilityPort,
  createRunLockPort,
  schedulerLockManagerFromPort
} from "./ports.js";
import type {
  ConfiguredWorkflowBootstrap,
  ConfiguredWorkflowFinalizer,
  ConfiguredWorkflowNodeRunner,
  ConfiguredWorkflowResult,
  ConfiguredWorkflowRunner,
  ConfiguredWorkflowFailureResult,
  ConfiguredWorkflowSuccessResult,
  FailureArtifactWriter,
  ObservabilityPortFactory,
  RunLockPort
} from "./contracts.js";
import type { Invocation } from "../router/invocation.js";
import type { RunIdentity } from "../invocation/types.js";
import type { ErrorArtifact } from "./errors.js";
import type { WorkspaceRecord } from "../write-mode/types.js";
import type { RepositoryWorkspaceBuiltInPorts } from "../../capabilities/repository-workspace/contracts.js";
import { officialCapabilityRegistry } from "../../capabilities/registry.js";
import type { RepositoryConfig } from "../config/schemas.js";
import {
  projectConfiguredWorkflowRuntimeNodes,
  type ConfiguredWorkflowRuntimeNode
} from "./runtime-node.js";

export type { RunGatedAgentLoopStepOptions };

type MaybePromise<T> = T | Promise<T>;

export type ConfiguredWorkflowRunnerDependencies = {
  createRunIdentity?: (
    invocation: Invocation,
    options: RunIdentityOptions
  ) => RunIdentity;
  routeInvocation?: typeof defaultRouteInvocation;
  resolveRepository?: (
    invocation: Invocation,
    repositories: readonly RepositoryConfig[]
  ) => RepositoryConfig;
  runBuiltInStep?: (options: RunBuiltInStepOptions) => MaybePromise<unknown>;
  agentRuntime?: AgentRuntimePort;
  resolveAgentTools?: (
    options: ResolveAgentToolCatalogOptions
  ) => MaybePromise<ResolvedToolCatalog>;
  resolveAgentOutputSchema?: (
    options: ResolveAgentOutputSchemaOptions
  ) => MaybePromise<unknown>;
  resolveAgentSkills?: (
    options: ResolveAgentSkillsOptions
  ) => MaybePromise<readonly ResolvedSkillReference[]>;
  runGatedAgentLoopStep?: (
    options: RunGatedAgentLoopStepOptions
  ) => MaybePromise<unknown>;
  cleanupWorktree?: typeof defaultCleanupWorktree;
  builtInStepRegistry?: BuiltInStepRegistryView;
  builtInStepDependencies?: BuiltInStepDependencies;
  repositoryWorkspacePortFactory?: (options: {
    lockManager: SchedulerLockManager;
  }) => RepositoryWorkspaceBuiltInPorts;
  lockManagerFactory?: (options: RunLockManagerOptions) => SchedulerLockManager;
  lockPortFactory?: (options: RunLockManagerOptions) => RunLockPort;
  observabilityPortFactory?: ObservabilityPortFactory;
  bootstrap?: ConfiguredWorkflowBootstrap;
  nodeRunner?: ConfiguredWorkflowNodeRunner;
  finalizer?: ConfiguredWorkflowFinalizer;
  failureArtifactWriter?: FailureArtifactWriter;
  ArtifactStore?: typeof ArtifactStore;
  now?: () => Date;
};

export type RunConfiguredWorkflowOptions = {
  invocation: Invocation;
  configRoot?: string;
  projectRoot?: string;
  workflowsRoot?: string;
  agentsRoot?: string;
  runtimeRunId?: string;
  observabilitySinks?: LunaObservabilitySink[];
  nonceFactory?: () => string;
  dependencies?: ConfiguredWorkflowRunnerDependencies;
  attempt?: number;
  throwOnError?: boolean;
};

export type {
  ConfiguredWorkflowFailureResult,
  ConfiguredWorkflowResult,
  ConfiguredWorkflowSuccessResult
};

function topologicalNodes(
  nodes: ConfiguredWorkflowRuntimeNode[]
): ConfiguredWorkflowRuntimeNode[] {
  const remaining = new Map(nodes.map((node) => [node.id, node]));
  const completed = new Set<string>();
  const ordered: ConfiguredWorkflowRuntimeNode[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].find((node) =>
      (node.after ?? []).every((dependency) => completed.has(dependency))
    );

    if (ready === undefined) {
      throw configuredWorkflowError(
        "Workflow graph cannot be ordered",
        "workflow_graph_unorderable"
      );
    }

    remaining.delete(ready.id);
    completed.add(ready.id);
    ordered.push(ready);
  }

  return ordered;
}

function isWorkspaceRecord(output: unknown): output is WorkspaceRecord {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return false;
  }

  const candidate = output as Partial<WorkspaceRecord>;
  return (
    typeof candidate.run_id === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.preserved === "boolean" &&
    typeof candidate.reason === "string"
  );
}

function builtInMetadata(
  node: ConfiguredWorkflowRuntimeNode,
  activeRegistry: BuiltInStepRegistryView
): BuiltInStepMetadata {
  if (node.type !== "built_in") {
    return {};
  }

  return activeRegistry.require(node.uses).metadata ?? {};
}

function finalReportFrom(output: unknown): JsonValue | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return undefined;
  }

  const report = (output as { json?: unknown }).json;
  if (report === undefined) {
    return undefined;
  }

  assertJsonValue(report, "$.report");
  return report;
}

function resolveWorkflowRepository({
  invocation,
  repositories,
  workflowId,
  required,
  resolveRepository
}: {
  invocation: Invocation;
  repositories: readonly RepositoryConfig[];
  workflowId: string;
  required: boolean;
  resolveRepository: (
    invocation: Invocation,
    repositories: readonly RepositoryConfig[]
  ) => RepositoryConfig;
}): RepositoryConfig | undefined {
  if (invocation.repository !== undefined) {
    return resolveRepository(invocation, repositories);
  }

  if (!required) {
    return undefined;
  }

  throw configuredWorkflowError(
    `Workflow ${workflowId} requires repository, but invocation did not provide one`,
    "repository_not_configured"
  );
}

export async function runConfiguredWorkflow({
  invocation,
  configRoot = resolveConfigRoot(),
  projectRoot,
  workflowsRoot,
  agentsRoot,
  runtimeRunId,
  observabilitySinks = [],
  nonceFactory,
  dependencies = {},
  attempt = 1,
  throwOnError = true
}: RunConfiguredWorkflowOptions): Promise<ConfiguredWorkflowResult> {
  const configs = await loadConfigs(configRoot);
  const makeRunIdentity =
    dependencies.createRunIdentity ?? defaultCreateRunIdentity;
  const Store = dependencies.ArtifactStore ?? ArtifactStore;
  const date = dependencies.now?.() ?? new Date();
  const nonce = (nonceFactory ?? createRunNonce)();
  const resolveRepository =
    dependencies.resolveRepository ?? defaultResolveRepository;
  const cleanupWorktree =
    dependencies.cleanupWorktree ?? defaultCleanupWorktree;
  const activeBuiltInStepRegistry =
    dependencies.builtInStepRegistry ?? defaultBuiltInStepRegistry;
  const bootstrapPort = dependencies.bootstrap ?? configuredWorkflowBootstrap;
  const nodeRunner = dependencies.nodeRunner ?? configuredWorkflowNodeRunner;
  const finalizer = dependencies.finalizer ?? configuredWorkflowFinalizer;
  const failureArtifactWriter =
    dependencies.failureArtifactWriter ??
    createFailureArtifactWriter({
      Store,
      configs,
      makeRunIdentity
    });
  const createLockPort =
    dependencies.lockPortFactory ??
    ((options: RunLockManagerOptions) => {
      const createLockManager =
        dependencies.lockManagerFactory ??
        ((managerOptions: RunLockManagerOptions) =>
          new RunLockManager(managerOptions));
      return createRunLockPort(createLockManager(options));
    });
  const createObservability =
    dependencies.observabilityPortFactory ?? createObservabilityPort;
  let workflowId: string | undefined;
  let workflowMode:
    | "read_only"
    | "trusted_local_write"
    | undefined;
  let run: RunIdentity | undefined;
  let artifactStore: ArtifactStore | undefined;
  let repository: RepositoryConfig | undefined;
  let workspaceRecord: WorkspaceRecord | undefined;
  let persistedWorkspaceRecord: WorkspaceRecord | undefined;
  let lockManager: SchedulerLockManager | undefined;
  let observability: LunaObservability | undefined;
  let summary: ObservabilitySummary | undefined;
  let workflowObservabilityConfig = defaultWorkflowObservabilityConfig;

  try {
    const bootstrap = await bootstrapPort.bootstrap({
      invocation,
      configRoot,
      workflowsRoot,
      agentsRoot,
      runtimeRunId,
      observabilitySinks,
      dependencies: {
        createRunIdentity: makeRunIdentity,
        routeInvocation: dependencies.routeInvocation,
        ArtifactStore: Store,
        builtInStepRegistry: activeBuiltInStepRegistry
      },
      attempt,
      date,
      nonce,
      configs
    });
    const { workflow, modelProfiles, resolvedAgentsRoot } = bootstrap;
    workflowId = bootstrap.workflowId;
    workflowObservabilityConfig = bootstrap.workflowObservabilityConfig;
    workflowMode = workflow.mode;
    run = bootstrap.run;
    artifactStore = bootstrap.artifactStore;
    observability = bootstrap.observability;
    summary = bootstrap.summary;
    const observabilityPort = createObservability(observability);
    const activeRuntimeRunId = runtimeRunId ?? run.run_id;
    await observabilityPort.emit({
      runtimeRunId: activeRuntimeRunId,
      event: runStartedEvent(observability.eventContext("info"))
    });
    await observabilityPort.emit({
      runtimeRunId: activeRuntimeRunId,
      event: customEvent({
        ...observability.eventContext("info"),
        type: "luna.run.routed",
        outcome: { status: "succeeded" }
      })
    });

    repository = resolveWorkflowRepository({
      invocation,
      repositories: configs.repositories.repositories,
      workflowId: workflow.id,
      required: workflow.requires.repository,
      resolveRepository
    });
    const configuredLockRoot = configs.app.locks?.root ?? ".luna/locks";
    const runtimeRoot = projectRoot ?? process.cwd();
    const lockRoot = path.isAbsolute(configuredLockRoot)
      ? configuredLockRoot
      : path.resolve(runtimeRoot, configuredLockRoot);
    const lockPort = createLockPort({
      root: lockRoot,
      runId: run.run_id,
      runtimeRunId,
      timeoutMs:
        workflow.execution.lock_timeout_ms ??
        configs.app.locks?.timeout_ms ??
        120000,
      staleAfterMs: configs.app.locks?.stale_after_ms ?? 600000,
      observability
    });
    lockManager = schedulerLockManagerFromPort({
      port: lockPort,
      runtimeRunId: activeRuntimeRunId
    });

    const state: SchedulerWorkflowState = {
      invocation,
      config: configs.runtimeConfig,
      repository,
      run,
      workflow: {
        id: workflow.id,
        mode: workflow.mode
      },
      workspaceRoot: configs.app.workspace.root,
      agentsRoot: resolvedAgentsRoot,
      steps: {}
    };
    const orderedNodes = topologicalNodes(
      projectConfiguredWorkflowRuntimeNodes(workflow)
    );
    const canonicalNodesById = new Map(
      workflow.graph.nodes.map((node) => [node.id, node])
    );
    const validateOutputBeforeCommit = async (
      node: ConfiguredWorkflowRuntimeNode,
      output: unknown
    ): Promise<void> => {
      const canonicalNode = canonicalNodesById.get(node.id);
      if (canonicalNode === undefined) {
        return;
      }
      if (canonicalNode.type === "agent") {
        await validateWorkflowAgentNodeOutput({
          node: canonicalNode,
          output,
          agentsRoot: resolvedAgentsRoot,
          declaredCapabilities: workflow.capabilities,
          capabilityRegistry: officialCapabilityRegistry,
          path: `$.steps.${node.id}`
        });
        return;
      }
      validateWorkflowNodeOutput({
        node: canonicalNode,
        output,
        declaredCapabilities: workflow.capabilities,
        capabilityRegistry: officialCapabilityRegistry,
        path: `$.steps.${node.id}`
      });
    };
    const { mainNodes, deferredNodes: deferredFinalReportNodes } =
      splitDeferredFinalReportNodesByPolicy({
        nodes: orderedNodes,
        builtInMetadata: (node) =>
          builtInMetadata(node, activeBuiltInStepRegistry)
      });
    const activeArtifactStore = artifactStore;
    const configuredRepositoryWorkspace =
      dependencies.builtInStepDependencies?.repositoryWorkspace ??
      dependencies.repositoryWorkspacePortFactory?.({ lockManager });
    const activeBuiltInStepDependencies: BuiltInStepDependencies = {
      ...dependencies.builtInStepDependencies,
      ...(configuredRepositoryWorkspace === undefined
        ? {}
        : { repositoryWorkspace: configuredRepositoryWorkspace })
    };
    const resolveAgentOutputSchema =
      dependencies.resolveAgentOutputSchema ??
      (async ({ node }: ResolveAgentOutputSchemaOptions) => {
        const canonicalNode = canonicalNodesById.get(node.id);
        if (canonicalNode?.type !== "agent") {
          return {};
        }

        return await resolveWorkflowAgentOutputSchema({
          agentId: canonicalNode.agent,
          schemaRef: canonicalNode.output_schema,
          agentsRoot: resolvedAgentsRoot,
          declaredCapabilities: workflow.capabilities,
          capabilityRegistry: officialCapabilityRegistry,
          path: `$.nodes.${node.id}.output_schema`
        });
      });
    const resolveAgentSkills =
      dependencies.resolveAgentSkills ??
      (async ({ agent, cwd }: ResolveAgentSkillsOptions) =>
        await resolveEffectiveSkillReferences({
          repository:
            repository === undefined || cwd === undefined
              ? undefined
              : {
                  root: cwd,
                  skills: repository.skills
                },
          agentDirectory: agent.directory,
          agentSkills: agent.skills
        }));
    const nodeRuntimeContext: WorkflowNodeRuntimeContext = {
      dependencies: {
        ...dependencies,
        builtInStepDependencies: activeBuiltInStepDependencies,
        resolveAgentOutputSchema,
        resolveAgentSkills
      },
      agentsRoot: resolvedAgentsRoot,
      modelProfiles,
      workflowSubagentPolicy: workflow.subagent_policy,
      observability,
      summary,
      artifactStore: activeArtifactStore
    };

    const scheduleResult = await runWorkflowSchedule({
      nodes: mainNodes,
      state,
      execution: { max_concurrency: workflow.execution.max_concurrency },
      observability,
      summary,
      runNode: async ({ node, state }) => {
        const output = await nodeRunner.runNode({
          node,
          state,
          context: nodeRuntimeContext
        });
        await validateOutputBeforeCommit(node, output);
        return output;
      },
      writePlannedArtifacts: async (node, output, state) =>
        await writePlannedArtifacts({
          artifactStore: activeArtifactStore,
          node,
          output,
          state
        }),
      builtInMetadata: (node) => builtInMetadata(node, activeBuiltInStepRegistry),
      lockManager
    });

    state.lifecycleEvidence = scheduleResult.lifecycleEvidence;
    workspaceRecord = scheduleResult.workspace;
    if (scheduleResult.workspace !== undefined) {
      persistedWorkspaceRecord = scheduleResult.workspace;
      state.workspace = scheduleResult.workspace;
    }

    if (scheduleResult.status === "failed") {
      const primaryFailure = scheduleResult.primaryFailure;
      const error = configuredWorkflowError(
        primaryFailure === undefined
          ? "Workflow scheduler failed"
          : `Workflow scheduler failed: ${primaryFailure.message}`,
        primaryFailure?.code ?? "scheduler_step_failed"
      );
      (error as Error & { details?: ErrorArtifact["details"] }).details = {
        ...(primaryFailure?.details ?? {})
      };
      throw error;
    }

    const successArtifactStore = artifactStore;
    const finalWorkspace = await withRepositoryCleanupLock({
      lockManager,
      repository,
      locked: cleanupMayRemoveWorktree({
        workspaceRecord,
        repository,
        workspaceConfig: configs.app.workspace,
        workflowMode: workflow.mode,
        implementationConfig: configs.runtimeConfig.implementation,
        lifecycleEvidence: lifecycleEvidenceFromSchedulerState(state),
        success: true
      }),
      run: async () =>
        await finalizer.finalizeSuccessWorkspace({
          artifactStore: successArtifactStore,
          workspaceRecord,
          persistedWorkspaceRecord,
          repository,
          workspaceConfig: configs.app.workspace,
          workflowMode: workflow.mode,
          implementationConfig: configs.runtimeConfig.implementation,
          lifecycleEvidence: lifecycleEvidenceFromSchedulerState(state),
          cleanupWorktree
        })
    });
    if (finalWorkspace !== undefined) {
      workspaceRecord = finalWorkspace;
      state.workspace = finalWorkspace;
    }

    let report: JsonValue | undefined;
    for (const node of deferredFinalReportNodes) {
      let output: unknown;
      try {
        output = await nodeRunner.runNode({
          node,
          state,
          context: {
            ...nodeRuntimeContext,
            artifactStore
          }
        });
        await validateOutputBeforeCommit(node, output);
      } catch (cause) {
        const error = configuredWorkflowError(
          `Workflow deferred node failed: ${errorMessage(cause)}`,
          "scheduler_step_failed",
          cause
        );
        (error as Error & { details?: Record<string, unknown> }).details = {
          step_id: node.id,
          cause_code: errorCode(cause),
          cause_message: errorMessage(cause)
        };
        throw error;
      }

      await writePlannedArtifacts({
        artifactStore,
        node,
        output,
        state
      });
      state.steps[node.id] = output;
      report = finalReportFrom(output) ?? report;
    }

    await observabilityPort.emit({
      runtimeRunId: activeRuntimeRunId,
      event: runCompletedEvent({
        ...observability.eventContext("info"),
        status: "succeeded"
      })
    });
    await writeSummaryBestEffort(artifactStore, summary);

    return {
      status: "success",
      run,
      workflow_id: workflow.id,
      steps: state.steps,
      ...(report === undefined ? {} : { report }),
      ...(isWorkspaceRecord(state.workspace) ? { workspace: state.workspace } : {})
    };
  } catch (error) {
    workflowId = workflowId ?? (error as { workflowId?: string }).workflowId;
    const failedWorkspace = (error as { workspaceRecord?: unknown })
      .workspaceRecord;
    if (isWorkspaceRecord(failedWorkspace)) {
      workspaceRecord = failedWorkspace;
    }

    const failure = await failureArtifactWriter.writeFailure({
      artifactStore,
      run,
      invocation,
      workflowId,
      attempt,
      date,
      runtimeRunId,
      nonce,
      error
    });
    artifactStore = failure.artifactStore;
    run = failure.run;
    workflowId = failure.workflowId;
    const artifact = failure.error;
    const artifactWriteError = failure.artifactWriteError;
    if (observability === undefined || summary === undefined) {
      try {
        ({ observability, summary } = await createRunObservability({
          artifactStore,
          run,
          workflowId,
          observabilityConfig: workflowObservabilityConfig,
          sinks: observabilitySinks
        }));
      } catch {
        observability = undefined;
        summary = undefined;
      }
    }
    const failureArtifactStore = artifactStore;
    if (observability !== undefined) {
      try {
        await createObservability(observability).emit({
          runtimeRunId: runtimeRunId ?? run.run_id,
          event: runCompletedEvent({
            ...observability.eventContext("error"),
            status: "failed",
            code: errorCode(error),
            data: sanitizeJsonObject({
              step_id: (error as { details?: ErrorArtifact["details"] })
                ?.details?.step_id,
              error
            })
          })
        });
      } catch {
        // Failure artifacts remain the source of truth if observability fails here.
      }
    }
    await writeSummaryBestEffort(artifactStore, summary);
    let finalWorkspace: WorkspaceRecord | undefined;
    const workspaceWriteError = await (async () => {
      try {
        finalWorkspace = await withRepositoryCleanupLock({
          lockManager,
          repository,
          locked: cleanupMayRemoveWorktree({
            workspaceRecord,
            repository,
            workspaceConfig: configs.app.workspace,
            workflowMode: workflowMode ?? "read_only",
            implementationConfig: configs.runtimeConfig.implementation,
            lifecycleEvidence: lifecycleEvidenceFromSchedulerState({}),
            success: false
          }),
          run: async () =>
            await finalizer.finalizeFailureWorkspace({
              artifactStore: failureArtifactStore,
              workspaceRecord,
              persistedWorkspaceRecord,
              repository,
              workspaceConfig: configs.app.workspace,
              cleanupWorktree
            })
        });
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();

    if (throwOnError) {
      throw error;
    }

    if (artifactWriteError !== undefined || workspaceWriteError !== undefined) {
      artifact.details = {
        ...(artifactWriteError === undefined
          ? {}
          : { error_artifact_write_failed: errorMessage(artifactWriteError) }),
        ...(workspaceWriteError === undefined
          ? {}
          : { workspace_artifact_write_failed: errorMessage(workspaceWriteError) })
      };
    }

    return {
      status: "failed",
      run,
      workflow_id: workflowId,
      error: artifact,
      ...(finalWorkspace === undefined ? {} : { workspace: finalWorkspace })
    };
  }
}

export const configuredWorkflowRunner = {
  run: runConfiguredWorkflow
} satisfies ConfiguredWorkflowRunner;
