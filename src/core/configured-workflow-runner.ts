import path from "node:path";
import { ArtifactStore } from "./artifact-store.js";
import {
  runBuiltInStep as defaultRunBuiltInStep,
  type BuiltInStepDependencies,
  type RunBuiltInStepOptions
} from "./built-in-steps.js";
import { loadYamlFile, resolveConfigRoot } from "./config-loader.js";
import { routeInvocation as defaultRouteInvocation } from "./router.js";
import { createRunIdentity as defaultCreateRunIdentity } from "./run-identity.js";
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
  node: Extract<WorkflowNode, { type: "agent" }>;
  state: WorkflowState;
  input: Record<string, unknown>;
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
};

export type ConfiguredWorkflowSuccessResult = {
  status: "success";
  run: RunIdentity;
  workflow_id: string;
  steps: Record<string, unknown>;
  workspace?: WorkspaceRecord;
};

function configuredWorkflowError(
  message: string,
  code: string,
  cause?: unknown
): Error & { code: string } {
  const error = new Error(message, { cause }) as Error & { code: string };
  error.code = code;

  return error;
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

async function runWorkflowNode(
  node: WorkflowNode,
  state: WorkflowState,
  dependencies: ConfiguredWorkflowRunnerDependencies
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

  return await dependencies.runAgentStep({
    node,
    state,
    input: resolveWorkflowInput(node.input, state)
  });
}

export async function runConfiguredWorkflow({
  invocation,
  configRoot = resolveConfigRoot(),
  workflowsRoot,
  defaultWorkflowId,
  dependencies = {},
  attempt = 1
}: RunConfiguredWorkflowOptions): Promise<ConfiguredWorkflowSuccessResult> {
  const configs = await loadConfigs(configRoot);
  void configs.models;

  const workflowId = workflowIdFromRoute(
    invocation,
    configs.routing,
    dependencies,
    defaultWorkflowId
  );
  const resolveRepository =
    dependencies.resolveRepository ?? defaultResolveRepository;
  const makeRunIdentity =
    dependencies.createRunIdentity ?? defaultCreateRunIdentity;
  const Store = dependencies.ArtifactStore ?? ArtifactStore;
  const repository = resolveRepository(
    invocation,
    configs.repositories.repositories
  );
  const run = makeRunIdentity(invocation, attempt, dependencies.now?.());
  const artifactStore = new Store(configs.app.artifacts.root, run.run_id);
  const state: WorkflowState = {
    invocation,
    repository,
    run,
    workspaceRoot: configs.app.workspace.root,
    steps: {}
  };

  await artifactStore.writeJson("invocation.json", invocation);
  await artifactStore.writeJson("run.json", run);

  const workflow = await loadConfiguredWorkflow(
    workflowsRoot ?? path.join(configRoot, "workflows"),
    workflowId
  );

  for (const node of topologicalNodes(workflow.graph.nodes)) {
    const output = await runWorkflowNode(node, state, dependencies);

    state.steps[node.id] = output;
    if (node.type === "built_in" && node.uses === "prepare_worktree") {
      if (isWorkspaceRecord(output)) {
        state.workspace = output;
      }
    }

    await writeNodeArtifact(artifactStore, node, output);
  }

  return {
    status: "success",
    run,
    workflow_id: workflow.id,
    steps: state.steps,
    ...(isWorkspaceRecord(state.workspace) ? { workspace: state.workspace } : {})
  };
}
