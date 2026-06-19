import path from "node:path";
import { ArtifactStore } from "./artifact-store.js";
import { cleanup as defaultCleanupWorktree } from "./git-worktree-manager.js";
import {
  runBuiltInStep as defaultRunBuiltInStep,
  type BuiltInStepDependencies,
  type RunBuiltInStepOptions
} from "./built-in-steps.js";
import {
  loadAgentDefinition,
  type AgentDefinition
} from "./agent-definition.js";
import { loadYamlFile, resolveConfigRoot } from "./config-loader.js";
import {
  resolveModelProfiles,
  toFlueModelOptions,
  type ResolvedModelProfiles
} from "./model-config.js";
import type { FinalReportJson } from "./report-builder.js";
import { routeInvocation as defaultRouteInvocation } from "./router.js";
import { createRunIdentity as defaultCreateRunIdentity } from "./run-identity.js";
import { safeJoin } from "./path-security.js";
import {
  loadWorkflowDefinition,
  type WorkflowNode
} from "./workflow-definition.js";
import { resolveWorkflowInput, type WorkflowState } from "./workflow-state.js";
import { resolveRepository as defaultResolveRepository } from "./workspace-resolver.js";
import {
  AppConfigSchema,
  ModelsConfigSchema,
  RepositoriesConfigSchema,
  RoutingConfigSchema,
  type AppConfig,
  type ErrorArtifact,
  type Invocation,
  type ModelsConfig,
  type RepositoriesConfig,
  type RepositoryConfig,
  type RouteTarget,
  type RoutingConfig,
  type RunIdentity,
  type WorkspaceRecord
} from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export type RunAgentStepOptions = {
  agent: AgentDefinition;
  node: Extract<WorkflowNode, { type: "agent" }>;
  model: ReturnType<typeof toFlueModelOptions>;
  input: Record<string, unknown>;
  state: WorkflowState;
};

export type ConfiguredWorkflowRunnerDependencies = {
  createRunIdentity?: (
    invocation: Invocation,
    attempt: number,
    date?: Date
  ) => RunIdentity;
  routeInvocation?: typeof defaultRouteInvocation;
  resolveRepository?: (
    invocation: Invocation,
    repositories: readonly RepositoryConfig[]
  ) => RepositoryConfig;
  runBuiltInStep?: (options: RunBuiltInStepOptions) => MaybePromise<unknown>;
  runAgentStep?: (options: RunAgentStepOptions) => MaybePromise<unknown>;
  cleanupWorktree?: typeof defaultCleanupWorktree;
  builtInStepDependencies?: BuiltInStepDependencies;
  ArtifactStore?: typeof ArtifactStore;
  now?: () => Date;
};

export type RunConfiguredWorkflowOptions = {
  invocation: Invocation;
  configRoot?: string;
  workflowsRoot?: string;
  agentsRoot?: string;
  defaultWorkflowId?: string;
  dependencies?: ConfiguredWorkflowRunnerDependencies;
  attempt?: number;
  throwOnError?: boolean;
};

export type ConfiguredWorkflowSuccessResult = {
  status: "success";
  run: RunIdentity;
  workflow_id: string;
  steps: Record<string, unknown>;
  report?: FinalReportJson;
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

function configuredWorkflowError(
  message: string,
  code: string,
  cause?: unknown
): Error & { code: string } {
  const error = new Error(message, { cause }) as Error & { code: string };
  error.code = code;

  return error;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && code !== "" ? code : "unknown_error";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }

  return String(error);
}

function errorArtifact(runId: string, error: unknown): ErrorArtifact {
  return {
    run_id: runId,
    code: errorCode(error),
    message: errorMessage(error)
  };
}

async function loadConfigs(configRoot: string): Promise<{
  app: AppConfig;
  repositories: RepositoriesConfig;
  routing: RoutingConfig;
  models: ModelsConfig;
}> {
  const app = await loadYamlFile(
    path.join(configRoot, "app.yaml"),
    AppConfigSchema
  );
  const repositories = await loadYamlFile(
    path.join(configRoot, "repositories.yaml"),
    RepositoriesConfigSchema
  );
  const routing = await loadYamlFile(
    path.join(configRoot, "routing.yaml"),
    RoutingConfigSchema
  );
  const models = await loadYamlFile(
    path.join(configRoot, "models.yaml"),
    ModelsConfigSchema
  );

  return { app, repositories, routing, models };
}

function workflowIdFromRoute(
  invocation: Invocation,
  routing: RoutingConfig,
  dependencies: ConfiguredWorkflowRunnerDependencies,
  defaultWorkflowId: string | undefined
): string {
  const routeInvocation = dependencies.routeInvocation ?? defaultRouteInvocation;
  let target: RouteTarget;

  try {
    target = routeInvocation(invocation, routing);
  } catch (cause) {
    const code = (cause as { code?: unknown })?.code;
    const canUseCompatibilityDefault =
      code === "no_route_matched" ||
      (code === "invalid_invocation" && invocation.target === "github_pr");

    if (defaultWorkflowId !== undefined && canUseCompatibilityDefault) {
      return defaultWorkflowId;
    }

    throw cause;
  }

  return target.id;
}

async function loadConfiguredWorkflow(
  workflowsRoot: string,
  workflowId: string
) {
  try {
    return await loadWorkflowDefinition(workflowsRoot, workflowId);
  } catch (cause) {
    throw configuredWorkflowError(
      `Failed to load workflow configuration: ${workflowId}`,
      "workflow_config_read_failed",
      cause
    );
  }
}

function topologicalNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  const remaining = new Map(nodes.map((node) => [node.id, node]));
  const completed = new Set<string>();
  const ordered: WorkflowNode[] = [];

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

async function writeNodeArtifact(
  artifactStore: ArtifactStore,
  node: WorkflowNode,
  output: unknown
): Promise<void> {
  if (typeof node.artifact === "string") {
    await artifactStore.writeJson(node.artifact, output);
    return;
  }

  if (
    node.artifact !== undefined &&
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output)
  ) {
    const outputRecord = output as Record<string, unknown>;

    for (const [outputKey, artifactName] of Object.entries(node.artifact)) {
      const value = outputRecord[outputKey];

      if (outputKey === "markdown") {
        await artifactStore.writeMarkdown(artifactName, String(value ?? ""));
      } else {
        await artifactStore.writeJson(artifactName, value);
      }
    }
  }
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

function isFinalReportNode(node: WorkflowNode): boolean {
  return node.type === "built_in" && node.uses === "final_code_review_report";
}

function finalReportFrom(output: unknown): FinalReportJson | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return undefined;
  }

  return (output as { json?: FinalReportJson }).json;
}

async function markdownArtifactPath({
  artifactRoot,
  runId,
  node
}: {
  artifactRoot: string;
  runId: string;
  node: WorkflowNode;
}): Promise<string | undefined> {
  if (
    node.artifact === undefined ||
    typeof node.artifact === "string" ||
    typeof node.artifact.markdown !== "string"
  ) {
    return undefined;
  }

  return await safeJoin(artifactRoot, [runId, node.artifact.markdown]);
}

async function writeJsonBestEffort(
  artifactStore: ArtifactStore,
  name: string,
  value: unknown
): Promise<unknown> {
  try {
    await artifactStore.writeJson(name, value);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function finalizeFailureWorkspace({
  artifactStore,
  workspaceRecord,
  persistedWorkspaceRecord,
  repository,
  workspaceConfig,
  cleanupWorktree
}: {
  artifactStore: ArtifactStore;
  workspaceRecord?: WorkspaceRecord;
  persistedWorkspaceRecord?: WorkspaceRecord;
  repository?: RepositoryConfig;
  workspaceConfig: AppConfig["workspace"];
  cleanupWorktree: typeof defaultCleanupWorktree;
}): Promise<WorkspaceRecord | undefined> {
  if (workspaceRecord === undefined) {
    return undefined;
  }

  let finalWorkspace = workspaceRecord;

  if (
    workspaceRecord.reason === "success_cleanup" ||
    workspaceRecord.reason === "success_cleanup_failed" ||
    workspaceRecord.reason === "success_preserved" ||
    workspaceRecord.reason === "failure_cleanup_failed" ||
    workspaceRecord.reason === "failure_preserved"
  ) {
    finalWorkspace = workspaceRecord;
  } else if (workspaceConfig.preserve_on_failure) {
    finalWorkspace = {
      ...workspaceRecord,
      preserved: true,
      reason: "failure_preserved"
    };
  } else if (repository !== undefined) {
    try {
      finalWorkspace = await cleanupWorktree({
        repositoryPath: repository.path,
        workspaceRoot: workspaceConfig.root,
        workspaceRecord,
        persistedWorkspaceRecord
      });
    } catch {
      finalWorkspace = {
        ...workspaceRecord,
        preserved: true,
        reason: "failure_cleanup_failed"
      };
    }
  }

  await artifactStore.writeJson("workspace.json", finalWorkspace);
  return finalWorkspace;
}

async function finalizeSuccessWorkspace({
  artifactStore,
  workspaceRecord,
  persistedWorkspaceRecord,
  repository,
  workspaceConfig,
  cleanupWorktree
}: {
  artifactStore: ArtifactStore;
  workspaceRecord?: WorkspaceRecord;
  persistedWorkspaceRecord?: WorkspaceRecord;
  repository?: RepositoryConfig;
  workspaceConfig: AppConfig["workspace"];
  cleanupWorktree: typeof defaultCleanupWorktree;
}): Promise<WorkspaceRecord | undefined> {
  if (workspaceRecord === undefined) {
    return undefined;
  }

  let finalWorkspace: WorkspaceRecord;

  if (!workspaceConfig.preserve_on_success) {
    if (repository === undefined) {
      finalWorkspace = workspaceRecord;
    } else {
      try {
        finalWorkspace = await cleanupWorktree({
          repositoryPath: repository.path,
          workspaceRoot: workspaceConfig.root,
          workspaceRecord,
          persistedWorkspaceRecord
        });
      } catch (cause) {
        const failedWorkspace = {
          ...workspaceRecord,
          preserved: true,
          reason: "success_cleanup_failed"
        };
        await artifactStore.writeJson("workspace.json", failedWorkspace);
        const error = configuredWorkflowError(
          "Successful review workspace cleanup failed",
          "success_cleanup_failed",
          cause
        );
        (error as Error & { workspaceRecord?: WorkspaceRecord }).workspaceRecord =
          failedWorkspace;
        throw error;
      }
    }
  } else {
    finalWorkspace = {
      ...workspaceRecord,
      preserved: true,
      reason: "success_preserved"
    };
  }

  await artifactStore.writeJson("workspace.json", finalWorkspace);
  return finalWorkspace;
}

function resolveAgentModel(
  agent: AgentDefinition,
  modelProfiles: ResolvedModelProfiles
): ReturnType<typeof toFlueModelOptions> {
  const profile = modelProfiles[agent.model_profile];

  if (profile === undefined) {
    throw configuredWorkflowError(
      `Model profile not found for agent ${agent.id}: ${agent.model_profile}`,
      "model_profile_missing"
    );
  }

  return toFlueModelOptions(profile);
}

async function runWorkflowNode(
  node: WorkflowNode,
  state: WorkflowState,
  dependencies: ConfiguredWorkflowRunnerDependencies,
  agentsRoot: string,
  modelProfiles: ResolvedModelProfiles
): Promise<unknown> {
  if (node.type === "built_in") {
    const runBuiltInStep =
      dependencies.runBuiltInStep ?? defaultRunBuiltInStep;

    return await runBuiltInStep({
      uses: node.uses,
      state,
      input: node.input,
      dependencies: dependencies.builtInStepDependencies
    });
  }

  if (dependencies.runAgentStep === undefined) {
    throw configuredWorkflowError(
      `No agent step runner configured for node: ${node.id}`,
      "agent_step_runner_missing"
    );
  }

  const agent = await loadAgentDefinition(agentsRoot, node.agent);

  return await dependencies.runAgentStep({
    agent,
    node,
    model: resolveAgentModel(agent, modelProfiles),
    input: resolveWorkflowInput(node.input, state),
    state
  });
}

export async function runConfiguredWorkflow({
  invocation,
  configRoot = resolveConfigRoot(),
  workflowsRoot,
  agentsRoot,
  defaultWorkflowId,
  dependencies = {},
  attempt = 1,
  throwOnError = true
}: RunConfiguredWorkflowOptions): Promise<ConfiguredWorkflowResult> {
  const configs = await loadConfigs(configRoot);
  const makeRunIdentity =
    dependencies.createRunIdentity ?? defaultCreateRunIdentity;
  const Store = dependencies.ArtifactStore ?? ArtifactStore;
  const run = makeRunIdentity(invocation, attempt, dependencies.now?.());
  const artifactStore = new Store(configs.app.artifacts.root, run.run_id);
  const modelProfiles = resolveModelProfiles(configs.models);
  const resolvedAgentsRoot = agentsRoot ?? path.join(configRoot, "agents");
  const resolveRepository =
    dependencies.resolveRepository ?? defaultResolveRepository;
  const cleanupWorktree =
    dependencies.cleanupWorktree ?? defaultCleanupWorktree;
  let workflowId: string | undefined;
  let repository: RepositoryConfig | undefined;
  let workspaceRecord: WorkspaceRecord | undefined;
  let persistedWorkspaceRecord: WorkspaceRecord | undefined;

  await artifactStore.writeJson("invocation.json", invocation);
  await artifactStore.writeJson("run.json", run);

  try {
    workflowId = workflowIdFromRoute(
      invocation,
      configs.routing,
      dependencies,
      defaultWorkflowId
    );
    repository = resolveRepository(
      invocation,
      configs.repositories.repositories
    );
    const workflow = await loadConfiguredWorkflow(
      workflowsRoot ?? path.join(configRoot, "workflows"),
      workflowId
    );
    const state: WorkflowState = {
      invocation,
      repository,
      run,
      workspaceRoot: configs.app.workspace.root,
      steps: {}
    };
    const orderedNodes = topologicalNodes(workflow.graph.nodes);
    const deferredFinalReportNodes: WorkflowNode[] = [];

    for (const node of orderedNodes) {
      if (isFinalReportNode(node)) {
        deferredFinalReportNodes.push(node);
        continue;
      }

      const output = await runWorkflowNode(
        node,
        state,
        dependencies,
        resolvedAgentsRoot,
        modelProfiles
      );

      state.steps[node.id] = output;
      if (node.type === "built_in" && node.uses === "prepare_worktree") {
        if (isWorkspaceRecord(output)) {
          state.workspace = output;
          workspaceRecord = output;
          persistedWorkspaceRecord = output;
        }
      }

      await writeNodeArtifact(artifactStore, node, output);
    }

    const finalWorkspace = await finalizeSuccessWorkspace({
      artifactStore,
      workspaceRecord,
      persistedWorkspaceRecord,
      repository,
      workspaceConfig: configs.app.workspace,
      cleanupWorktree
    });
    if (finalWorkspace !== undefined) {
      workspaceRecord = finalWorkspace;
      state.workspace = finalWorkspace;
    }

    let report: FinalReportJson | undefined;
    for (const node of deferredFinalReportNodes) {
      const reportPath = await markdownArtifactPath({
        artifactRoot: configs.app.artifacts.root,
        runId: run.run_id,
        node
      });
      if (reportPath !== undefined) {
        state.reportPath = reportPath;
      }

      const output = await runWorkflowNode(
        node,
        state,
        dependencies,
        resolvedAgentsRoot,
        modelProfiles
      );

      state.steps[node.id] = output;
      await writeNodeArtifact(artifactStore, node, output);
      report = finalReportFrom(output) ?? report;
    }

    return {
      status: "success",
      run,
      workflow_id: workflow.id,
      steps: state.steps,
      ...(report === undefined ? {} : { report }),
      ...(isWorkspaceRecord(state.workspace) ? { workspace: state.workspace } : {})
    };
  } catch (error) {
    const failedWorkspace = (error as { workspaceRecord?: unknown })
      .workspaceRecord;
    if (isWorkspaceRecord(failedWorkspace)) {
      workspaceRecord = failedWorkspace;
    }

    const artifact = errorArtifact(run.run_id, error);
    const artifactWriteError = await writeJsonBestEffort(
      artifactStore,
      "error.json",
      artifact
    );
    let finalWorkspace: WorkspaceRecord | undefined;
    const workspaceWriteError = await (async () => {
      try {
        finalWorkspace = await finalizeFailureWorkspace({
          artifactStore,
          workspaceRecord,
          persistedWorkspaceRecord,
          repository,
          workspaceConfig: configs.app.workspace,
          cleanupWorktree
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
      ...(workflowId === undefined ? {} : { workflow_id: workflowId }),
      error: artifact,
      workspace: finalWorkspace
    };
  }
}
