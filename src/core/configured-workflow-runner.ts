import { access } from "node:fs/promises";
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
import { shouldPreserveWriteWorkspace } from "./workspace-lifecycle.js";
import {
  loadWorkflowDefinition,
  type WorkflowNode
} from "./workflow-definition.js";
import { resolveWorkflowInput, type WorkflowState } from "./workflow-state.js";
import { resolveRepository as defaultResolveRepository } from "./workspace-resolver.js";
import {
  AppConfigSchema,
  ImplementationConfigSchema,
  JiraConfigSchema,
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
  type RuntimeConfigState,
  type RoutingConfig,
  type RunIdentity,
  type ValidationCommand,
  ValidationCommandSchema,
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

type AgentLoopWorkflowNode = Extract<WorkflowNode, { type: "agent_loop" }>;

type ResolvedAgentLoopNode = Omit<
  AgentLoopWorkflowNode,
  "sandbox" | "validation" | "repair"
> & {
  sandbox: {
    type: "trusted_host_local";
    cwd: string;
    env_allowlist: string[];
  };
  validation: {
    commands: ValidationCommand[];
    max_output_bytes: number;
  };
  repair: {
    attempts: number;
  };
};

export type RunAgentLoopStepOptions = {
  agent: AgentDefinition;
  node: ResolvedAgentLoopNode;
  model: ReturnType<typeof toFlueModelOptions>;
  input: Record<string, unknown>;
  sandbox: ResolvedAgentLoopNode["sandbox"];
  validation: ResolvedAgentLoopNode["validation"];
  repair: ResolvedAgentLoopNode["repair"];
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
  runAgentLoopStep?: (
    options: RunAgentLoopStepOptions
  ) => MaybePromise<unknown>;
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
  runtimeConfig: RuntimeConfigState;
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
  const runtimeConfig = await loadRuntimeConfig(configRoot);

  return { app, repositories, routing, models, runtimeConfig };
}

async function loadRuntimeConfig(
  configRoot: string
): Promise<RuntimeConfigState> {
  const jiraPath = path.join(configRoot, "jira.yaml");
  const implementationPath = path.join(configRoot, "implementation.yaml");
  const [jira, implementation] = await Promise.all([
    loadOptionalYamlFile(jiraPath, JiraConfigSchema),
    loadOptionalYamlFile(implementationPath, ImplementationConfigSchema)
  ]);

  return {
    ...(jira === undefined ? {} : { jira }),
    ...(implementation === undefined
      ? {}
      : { implementation: implementation.implementation })
  };
}

async function loadOptionalYamlFile<T>(
  filePath: string,
  schema: { parse(value: unknown): T }
): Promise<T | undefined> {
  if (!(await pathExists(filePath))) {
    return undefined;
  }

  return await loadYamlFile(filePath, schema);
}

function workflowIdFromRoute(
  invocation: Invocation,
  routing: RoutingConfig,
  dependencies: ConfiguredWorkflowRunnerDependencies
): string {
  const routeInvocation = dependencies.routeInvocation ?? defaultRouteInvocation;
  const target: RouteTarget = routeInvocation(invocation, routing);

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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveConfiguredDirectoryRoot(
  configRoot: string,
  configuredRoot: string | undefined,
  directoryName: "agents" | "workflows"
): Promise<string> {
  if (configuredRoot !== undefined) {
    return configuredRoot;
  }

  const configRelativeRoot = path.join(configRoot, directoryName);
  if (await pathExists(configRelativeRoot)) {
    return configRelativeRoot;
  }

  return directoryName;
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
  return (
    node.type === "built_in" &&
    (node.uses === "final_code_review_report" ||
      node.uses === "final_implementation_report")
  );
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
  workflowMode,
  implementationConfig,
  steps,
  cleanupWorktree
}: {
  artifactStore: ArtifactStore;
  workspaceRecord?: WorkspaceRecord;
  persistedWorkspaceRecord?: WorkspaceRecord;
  repository?: RepositoryConfig;
  workspaceConfig: AppConfig["workspace"];
  workflowMode: "git_managed_read_only" | "git_managed_write";
  implementationConfig?: RuntimeConfigState["implementation"];
  steps: Record<string, unknown>;
  cleanupWorktree: typeof defaultCleanupWorktree;
}): Promise<WorkspaceRecord | undefined> {
  if (workspaceRecord === undefined) {
    return undefined;
  }

  if (workflowMode === "git_managed_write") {
    return await finalizeWriteSuccessWorkspace({
      artifactStore,
      workspaceRecord,
      persistedWorkspaceRecord,
      repository,
      workspaceConfig,
      implementationConfig,
      steps,
      cleanupWorktree
    });
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

async function finalizeWriteSuccessWorkspace({
  artifactStore,
  workspaceRecord,
  persistedWorkspaceRecord,
  repository,
  workspaceConfig,
  implementationConfig,
  steps,
  cleanupWorktree
}: {
  artifactStore: ArtifactStore;
  workspaceRecord: WorkspaceRecord;
  persistedWorkspaceRecord?: WorkspaceRecord;
  repository?: RepositoryConfig;
  workspaceConfig: AppConfig["workspace"];
  implementationConfig?: RuntimeConfigState["implementation"];
  steps: Record<string, unknown>;
  cleanupWorktree: typeof defaultCleanupWorktree;
}): Promise<WorkspaceRecord> {
  const lifecycle = shouldPreserveWriteWorkspace({
    commitEnabled: implementationConfig?.commit.enabled ?? false,
    validationPassed: validationPassedFromSteps(steps),
    acceptanceAccepted: acceptanceAcceptedFromSteps(steps),
    commitSkippedOrFailed: commitSkippedOrFailed(
      implementationConfig?.commit.enabled ?? false,
      steps.commit ?? steps.commit_changes
    ),
    pushSkippedOrFailed: pushSkippedOrFailed(
      implementationConfig?.push.enabled ?? false,
      steps.push ?? steps.push_branch
    ),
    pullRequestSkippedOrFailed: pullRequestSkippedOrFailed(
      implementationConfig?.pull_request.enabled ?? false,
      steps.pull_request ?? steps.open_pull_request
    )
  });

  if (lifecycle.preserve) {
    const finalWorkspace = {
      ...workspaceRecord,
      preserved: true,
      reason: lifecycle.reason
    };
    await artifactStore.writeJson("workspace.json", finalWorkspace);
    return finalWorkspace;
  }

  if (repository === undefined) {
    await artifactStore.writeJson("workspace.json", workspaceRecord);
    return workspaceRecord;
  }

  try {
    const finalWorkspace = await cleanupWorktree({
      repositoryPath: repository.path,
      workspaceRoot: workspaceConfig.root,
      workspaceRecord,
      persistedWorkspaceRecord
    });
    await artifactStore.writeJson("workspace.json", finalWorkspace);
    return finalWorkspace;
  } catch (cause) {
    const failedWorkspace = {
      ...workspaceRecord,
      preserved: true,
      reason: "success_cleanup_failed"
    };
    await artifactStore.writeJson("workspace.json", failedWorkspace);
    const error = configuredWorkflowError(
      "Successful implementation workspace cleanup failed",
      "success_cleanup_failed",
      cause
    );
    (error as Error & { workspaceRecord?: WorkspaceRecord }).workspaceRecord =
      failedWorkspace;
    throw error;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function booleanAt(
  value: unknown,
  pathSegments: readonly string[]
): boolean | undefined {
  let current = value;

  for (const segment of pathSegments) {
    const record = recordValue(current);
    if (record === undefined) {
      return undefined;
    }

    current = record[segment];
  }

  return typeof current === "boolean" ? current : undefined;
}

function validationPassedFromSteps(steps: Record<string, unknown>): boolean {
  for (const value of Object.values(steps)) {
    const passed =
      booleanAt(value, ["final_validation", "passed"]) ??
      booleanAt(value, ["validation", "passed"]) ??
      booleanAt(value, ["passed"]);

    if (passed !== undefined) {
      return passed;
    }
  }

  return false;
}

function acceptanceAcceptedFromSteps(steps: Record<string, unknown>): boolean {
  const acceptance = recordValue(
    steps.acceptance ?? steps.implementation_acceptance
  );

  if (acceptance === undefined) {
    return false;
  }

  return acceptance.status === "accepted" || acceptance.decision === "approve";
}

function gateSkippedOrFailed(gateEnabled: boolean, value: unknown): boolean {
  if (!gateEnabled) {
    return false;
  }

  const record = recordValue(value);
  if (record === undefined) {
    return true;
  }

  return record.skipped === true || record.status === "failed";
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function gateSkippedOrFailedWithoutEvidence(
  gateEnabled: boolean,
  value: unknown,
  hasSuccessEvidence: (record: Record<string, unknown>) => boolean
): boolean {
  if (!gateEnabled) {
    return false;
  }

  if (gateSkippedOrFailed(gateEnabled, value)) {
    return true;
  }

  const record = recordValue(value);
  return record === undefined || !hasSuccessEvidence(record);
}

function commitSkippedOrFailed(gateEnabled: boolean, value: unknown): boolean {
  return gateSkippedOrFailedWithoutEvidence(gateEnabled, value, (record) =>
    nonEmptyString(record.commit_sha)
  );
}

function pushSkippedOrFailed(gateEnabled: boolean, value: unknown): boolean {
  return gateSkippedOrFailedWithoutEvidence(gateEnabled, value, (record) => {
    if (record.pushed === true) {
      return true;
    }

    return (
      nonEmptyString(record.remote) &&
      (nonEmptyString(record.branch) || nonEmptyString(record.ref))
    );
  });
}

function pullRequestSkippedOrFailed(
  gateEnabled: boolean,
  value: unknown
): boolean {
  return gateSkippedOrFailedWithoutEvidence(gateEnabled, value, (record) =>
    nonEmptyString(record.url) || positiveInteger(record.number)
  );
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

function validateAgentLoopCommands(value: unknown): ValidationCommand[] {
  const parsed = ValidationCommandSchema.array().safeParse(value);

  if (!parsed.success) {
    throw configuredWorkflowError(
      "Agent loop validation.commands must resolve to structured validation commands",
      "agent_loop_validation_commands_invalid",
      parsed.error
    );
  }

  return parsed.data;
}

function validatePositiveInteger(
  value: unknown,
  message: string,
  code: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw configuredWorkflowError(message, code);
  }

  return value;
}

function validateNonnegativeInteger(
  value: unknown,
  message: string,
  code: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw configuredWorkflowError(message, code);
  }

  return value;
}

function resolveAgentLoopNode(
  node: AgentLoopWorkflowNode,
  state: WorkflowState
): ResolvedAgentLoopNode {
  const sandbox = resolveWorkflowInput(node.sandbox, state);
  const validation = resolveWorkflowInput(node.validation, state);
  const repair = resolveWorkflowInput(node.repair, state);
  const cwd = sandbox.cwd;

  if (typeof cwd !== "string" || cwd === "") {
    throw configuredWorkflowError(
      "Agent loop sandbox.cwd must resolve to a path",
      "agent_loop_sandbox_cwd_invalid"
    );
  }

  return {
    ...node,
    sandbox: {
      type: "trusted_host_local",
      cwd,
      env_allowlist: node.sandbox.env_allowlist
    },
    validation: {
      commands: validateAgentLoopCommands(validation.commands),
      max_output_bytes: validatePositiveInteger(
        validation.max_output_bytes,
        "Agent loop validation.max_output_bytes must resolve to a number",
        "agent_loop_validation_max_output_bytes_invalid"
      )
    },
    repair: {
      attempts: validateNonnegativeInteger(
        repair.attempts,
        "Agent loop repair.attempts must resolve to a number",
        "agent_loop_repair_attempts_invalid"
      )
    }
  };
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
      input:
        node.input === undefined
          ? undefined
          : resolveWorkflowInput(node.input, state),
      dependencies: dependencies.builtInStepDependencies
    });
  }

  if (node.type === "agent_loop") {
    if (dependencies.runAgentLoopStep === undefined) {
      throw configuredWorkflowError(
        `No agent loop runner configured for node: ${node.id}`,
        "agent_loop_runner_missing"
      );
    }

    const agent = await loadAgentDefinition(agentsRoot, node.agent);
    const resolvedNode = resolveAgentLoopNode(node, state);

    return await dependencies.runAgentLoopStep({
      agent,
      node: resolvedNode,
      model: resolveAgentModel(agent, modelProfiles),
      input: resolveWorkflowInput(node.input, state),
      sandbox: resolvedNode.sandbox,
      validation: resolvedNode.validation,
      repair: resolvedNode.repair,
      state
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
  const resolvedAgentsRoot = await resolveConfiguredDirectoryRoot(
    configRoot,
    agentsRoot,
    "agents"
  );
  const resolvedWorkflowsRoot = await resolveConfiguredDirectoryRoot(
    configRoot,
    workflowsRoot,
    "workflows"
  );
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
      dependencies
    );
    repository = resolveRepository(
      invocation,
      configs.repositories.repositories
    );
    const workflow = await loadConfiguredWorkflow(
      resolvedWorkflowsRoot,
      workflowId
    );
    const state: WorkflowState = {
      invocation,
      config: configs.runtimeConfig,
      repository,
      run,
      workflow: {
        id: workflow.id,
        mode: workflow.mode
      },
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
      if (
        node.type === "built_in" &&
        (node.uses === "prepare_worktree" ||
          node.uses === "prepare_implementation_worktree")
      ) {
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
      workflowMode: workflow.mode,
      implementationConfig: configs.runtimeConfig.implementation,
      steps: state.steps,
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
