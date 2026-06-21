import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { writePlannedArtifacts } from "./artifact-write-plan.js";
import { ArtifactStore } from "./artifact-store.js";
import { cleanup as defaultCleanupWorktree } from "./git-worktree-manager.js";
import {
  builtInStepRegistry as defaultBuiltInStepRegistry,
  runBuiltInStep as defaultRunBuiltInStep,
  type BuiltInStepDependencies,
  type BuiltInStepMetadata,
  type RunBuiltInStepOptions
} from "./built-ins/index.js";
import {
  loadAgentDefinition,
  type AgentDefinition
} from "./agent-definition.js";
import {
  loadOptionalYamlFile,
  loadYamlFile,
  resolveConfigRoot
} from "./config-loader.js";
import {
  resolveModelProfiles,
  toFlueModelOptions,
  type ResolvedModelProfiles
} from "./model-config.js";
import type { McpConfig } from "./mcp-config.js";
import { assertJsonValue, type JsonValue } from "./json-value.js";
import { routeInvocation as defaultRouteInvocation } from "./router.js";
import {
  RunLockManager,
  type RunLockManagerOptions
} from "./run-lock-manager.js";
import { createJsonlEventSink } from "./observability/jsonl-sink.js";
import { createObservabilitySinks } from "./observability/exporter-config.js";
import {
  createLunaObservability,
  customEvent,
  runCompletedEvent,
  runStartedEvent,
  type LunaObservability,
  type LunaObservabilitySink
} from "./observability/luna-observability.js";
import { sanitizeJsonObject } from "./observability/sanitize.js";
import {
  createObservabilitySummary,
  writeSummaryBestEffort,
  type ObservabilitySummary
} from "./observability/summary.js";
import {
  runWorkflowSchedule,
  splitDeferredFinalReportNodes,
  type SchedulerLockManager
} from "./workflow-scheduler.js";
import {
  createRunIdentity as defaultCreateRunIdentity,
  type RunIdentityOptions
} from "./run-identity.js";
import {
  implementationLifecycleEvidenceFromSteps
} from "./implementation-lifecycle.js";
import { assertSafeSegment } from "./path-security.js";
import { shouldPreserveWriteWorkspace } from "./workspace-lifecycle.js";
import {
  defaultWorkflowObservabilityConfig,
  loadWorkflowDefinition,
  type WorkflowObservabilityConfig,
  type WorkflowNode
} from "./workflow-definition.js";
import type { WorkflowSubagentPolicy } from "./subagent-policy.js";
import {
  resolveWorkflowInput,
  type SchedulerWorkflowState,
  type WorkflowState
} from "./workflow-state.js";
import { resolveRepository as defaultResolveRepository } from "./workspace-resolver.js";
import {
  AppConfigSchema,
  ImplementationConfigSchema,
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

type BuiltInMetadataRegistry = {
  require(name: string): { metadata?: BuiltInStepMetadata };
};

export type RunAgentStepOptions = {
  agent: AgentDefinition;
  node: Extract<WorkflowNode, { type: "agent" }>;
  model: ReturnType<typeof toFlueModelOptions>;
  agentsRoot: string;
  modelProfiles: ResolvedModelProfiles;
  workflowSubagentPolicy: WorkflowSubagentPolicy;
  input: Record<string, unknown>;
  state: WorkflowState;
  mcpConfig?: McpConfig;
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  artifactStore?: ArtifactStore;
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
  agentsRoot: string;
  modelProfiles: ResolvedModelProfiles;
  workflowSubagentPolicy: WorkflowSubagentPolicy;
  input: Record<string, unknown>;
  sandbox: ResolvedAgentLoopNode["sandbox"];
  validation: ResolvedAgentLoopNode["validation"];
  repair: ResolvedAgentLoopNode["repair"];
  state: WorkflowState;
  mcpConfig?: McpConfig;
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  artifactStore?: ArtifactStore;
};

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
  runAgentStep?: (options: RunAgentStepOptions) => MaybePromise<unknown>;
  runAgentLoopStep?: (
    options: RunAgentLoopStepOptions
  ) => MaybePromise<unknown>;
  cleanupWorktree?: typeof defaultCleanupWorktree;
  builtInStepRegistry?: BuiltInMetadataRegistry;
  builtInStepDependencies?: BuiltInStepDependencies;
  lockManagerFactory?: (options: RunLockManagerOptions) => SchedulerLockManager;
  ArtifactStore?: typeof ArtifactStore;
  now?: () => Date;
};

export type RunConfiguredWorkflowOptions = {
  invocation: Invocation;
  configRoot?: string;
  projectRoot?: string;
  workflowsRoot?: string;
  agentsRoot?: string;
  flueRunId?: string;
  observabilitySinks?: LunaObservabilitySink[];
  nonceFactory?: () => string;
  dependencies?: ConfiguredWorkflowRunnerDependencies;
  attempt?: number;
  throwOnError?: boolean;
};

type WorkflowNodeRuntimeContext = {
  dependencies: ConfiguredWorkflowRunnerDependencies;
  agentsRoot: string;
  modelProfiles: ResolvedModelProfiles;
  workflowSubagentPolicy: WorkflowSubagentPolicy;
  observability?: LunaObservability;
  summary?: ObservabilitySummary;
  artifactStore?: ArtifactStore;
};

export type ConfiguredWorkflowSuccessResult = {
  status: "success";
  run: RunIdentity;
  workflow_id: string;
  steps: Record<string, unknown>;
  report?: JsonValue;
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
  const details = (error as { details?: ErrorArtifact["details"] })?.details;

  return {
    run_id: runId,
    code: errorCode(error),
    message: errorMessage(error),
    ...(details === undefined ? {} : { details })
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
  const implementationPath = path.join(configRoot, "implementation.yaml");
  const implementation = await loadOptionalYamlFile(
    implementationPath,
    ImplementationConfigSchema
  );

  return {
    ...(implementation === undefined
      ? {}
      : { implementation: implementation.implementation })
  };
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
  node: WorkflowNode,
  activeRegistry: BuiltInMetadataRegistry
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

function artifactRootForWorkflow(root: string, workflowId: string): string {
  assertSafeSegment(workflowId);
  return path.join(root, workflowId);
}

function createRunNonce(): string {
  return randomBytes(4).toString("hex");
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

async function createRunObservability({
  artifactStore,
  run,
  workflowId,
  observabilityConfig,
  sinks
}: {
  artifactStore: ArtifactStore;
  run: RunIdentity;
  workflowId: string;
  observabilityConfig: WorkflowObservabilityConfig;
  sinks: LunaObservabilitySink[];
}): Promise<{
  observability: LunaObservability;
  summary: ObservabilitySummary;
}> {
  const jsonlSink = await createJsonlEventSink(artifactStore);
  const summary = createObservabilitySummary({
    runId: run.run_id,
    workflowId
  });
  const observability = createLunaObservability({
    run: {
      id: run.run_id,
      flueRunId: run.flue_run_id,
      attempt: run.attempt
    },
    workflow: { id: workflowId },
    sinks: createObservabilitySinks({
      config: observabilityConfig,
      jsonlSink,
      flueLogSinks: sinks
    })
  });

  await writeSummaryBestEffort(artifactStore, summary);

  return { observability, summary };
}

async function ensureFailureArtifactStore({
  artifactStore,
  Store,
  configs,
  run,
  makeRunIdentity,
  invocation,
  workflowId,
  attempt,
  date,
  flueRunId,
  nonce
}: {
  artifactStore?: ArtifactStore;
  Store: typeof ArtifactStore;
  configs: { app: AppConfig };
  run?: RunIdentity;
  makeRunIdentity: (
    invocation: Invocation,
    options: RunIdentityOptions
  ) => RunIdentity;
  invocation: Invocation;
  workflowId?: string;
  attempt: number;
  date: Date;
  flueRunId?: string;
  nonce: string;
}): Promise<{
  artifactStore: ArtifactStore;
  run: RunIdentity;
  workflowId: string;
}> {
  if (artifactStore !== undefined && run !== undefined) {
    return { artifactStore, run, workflowId: run.workflow_id };
  }

  const failureWorkflowId = workflowId ?? "_failed";
  const failureRun = makeRunIdentity(invocation, {
    workflowId: failureWorkflowId,
    attempt,
    date,
    flueRunId,
    nonce
  });
  const failureArtifactStore = new Store(
    artifactRootForWorkflow(configs.app.artifacts.root, failureWorkflowId),
    failureRun.run_id
  );
  await failureArtifactStore.initializeRunDirectory();
  await failureArtifactStore.writeJson("invocation.json", invocation);
  await failureArtifactStore.writeJson("run.json", failureRun);

  return {
    artifactStore: failureArtifactStore,
    run: failureRun,
    workflowId: failureWorkflowId
  };
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

function cleanupMayRemoveWorktree({
  workspaceRecord,
  repository,
  workspaceConfig,
  workflowMode,
  implementationConfig,
  steps,
  success
}: {
  workspaceRecord?: WorkspaceRecord;
  repository?: RepositoryConfig;
  workspaceConfig: AppConfig["workspace"];
  workflowMode: "git_managed_read_only" | "git_managed_write";
  implementationConfig?: RuntimeConfigState["implementation"];
  steps: Record<string, unknown>;
  success: boolean;
}): boolean {
  if (workspaceRecord === undefined || repository === undefined) {
    return false;
  }

  if (!success) {
    return !workspaceConfig.preserve_on_failure;
  }

  if (workflowMode === "git_managed_read_only") {
    return !workspaceConfig.preserve_on_success;
  }

  return !shouldPreserveWriteWorkspace({
    commitEnabled: implementationConfig?.commit.enabled ?? false,
    pushEnabled: implementationConfig?.push.enabled ?? false,
    pullRequestEnabled: implementationConfig?.pull_request.enabled ?? false,
    acceptanceAccepted: acceptanceAcceptedFromSteps(steps),
    evidence: implementationLifecycleEvidenceFromSteps({
      workspaceCreated: workspaceRecord !== undefined,
      steps,
      gates: {
        commitEnabled: implementationConfig?.commit.enabled ?? false,
        pushEnabled: implementationConfig?.push.enabled ?? false,
        pullRequestEnabled: implementationConfig?.pull_request.enabled ?? false
      }
    })
  }).preserve;
}

async function withRepositoryCleanupLock<T>({
  lockManager,
  repository,
  locked,
  run
}: {
  lockManager?: SchedulerLockManager;
  repository?: RepositoryConfig;
  locked: boolean;
  run: () => Promise<T>;
}): Promise<T> {
  if (!locked || repository === undefined) {
    return await run();
  }

  if (lockManager === undefined) {
    throw configuredWorkflowError(
      "Lock manager is missing",
      "lock_manager_missing"
    );
  }

  const release = await lockManager.acquire(
    `repository:${repository.id}`,
    "exclusive"
  );
  let operationError: unknown;

  try {
    return await run();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (error) {
      if (
        operationError !== undefined &&
        ((typeof operationError === "object" && operationError !== null) ||
          typeof operationError === "function")
      ) {
        Object.defineProperty(operationError, "releaseErrors", {
          configurable: true,
          value: [error]
        });
      } else {
        throw configuredWorkflowError(
          "Failed to release workflow lock",
          "lock_release_failed",
          error
        );
      }
    }
  }
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
    pushEnabled: implementationConfig?.push.enabled ?? false,
    pullRequestEnabled: implementationConfig?.pull_request.enabled ?? false,
    acceptanceAccepted: acceptanceAcceptedFromSteps(steps),
    evidence: implementationLifecycleEvidenceFromSteps({
      workspaceCreated: workspaceRecord !== undefined,
      steps,
      gates: {
        commitEnabled: implementationConfig?.commit.enabled ?? false,
        pushEnabled: implementationConfig?.push.enabled ?? false,
        pullRequestEnabled: implementationConfig?.pull_request.enabled ?? false
      }
    })
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

function acceptanceAcceptedFromSteps(steps: Record<string, unknown>): boolean {
  const acceptance = recordValue(
    steps.acceptance ?? steps.implementation_acceptance
  );

  if (acceptance === undefined) {
    return false;
  }

  return acceptance.status === "accepted" || acceptance.decision === "approve";
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
  context: WorkflowNodeRuntimeContext
): Promise<unknown> {
  if (node.type === "built_in") {
    const runBuiltInStep =
      context.dependencies.runBuiltInStep ?? defaultRunBuiltInStep;

    return await runBuiltInStep({
      uses: node.uses,
      state,
      input:
        node.input === undefined
          ? undefined
          : resolveWorkflowInput(node.input, state),
      dependencies: context.dependencies.builtInStepDependencies
    });
  }

  if (node.type === "agent_loop") {
    if (context.dependencies.runAgentLoopStep === undefined) {
      throw configuredWorkflowError(
        `No agent loop runner configured for node: ${node.id}`,
        "agent_loop_runner_missing"
      );
    }

    const agent = await loadAgentDefinition(context.agentsRoot, node.agent);
    const resolvedNode = resolveAgentLoopNode(node, state);

    return await context.dependencies.runAgentLoopStep({
      agent,
      node: resolvedNode,
      model: resolveAgentModel(agent, context.modelProfiles),
      agentsRoot: context.agentsRoot,
      modelProfiles: context.modelProfiles,
      workflowSubagentPolicy: context.workflowSubagentPolicy,
      input: resolveWorkflowInput(node.input, state),
      sandbox: resolvedNode.sandbox,
      validation: resolvedNode.validation,
      repair: resolvedNode.repair,
      state,
      observability: context.observability,
      summary: context.summary,
      artifactStore: context.artifactStore
    });
  }

  if (context.dependencies.runAgentStep === undefined) {
    throw configuredWorkflowError(
      `No agent step runner configured for node: ${node.id}`,
      "agent_step_runner_missing"
    );
  }

  const agent = await loadAgentDefinition(context.agentsRoot, node.agent);

  return await context.dependencies.runAgentStep({
    agent,
    node,
    model: resolveAgentModel(agent, context.modelProfiles),
    agentsRoot: context.agentsRoot,
    modelProfiles: context.modelProfiles,
    workflowSubagentPolicy: context.workflowSubagentPolicy,
    input: resolveWorkflowInput(node.input, state),
    state,
    observability: context.observability,
    summary: context.summary,
    artifactStore: context.artifactStore
  });
}

function firstSchedulerFailure(
  steps: Record<string, unknown>
): { code: string; details?: ErrorArtifact["details"] } | undefined {
  for (const value of Object.values(steps)) {
    const record = recordValue(value);
    if (record?.status !== "failed") {
      continue;
    }

    const code = record.code;
    if (typeof code !== "string" || code === "") {
      continue;
    }

    const details = recordValue(record.details);
    return {
      code,
      ...(details === undefined ? {} : { details })
    };
  }

  return undefined;
}

export async function runConfiguredWorkflow({
  invocation,
  configRoot = resolveConfigRoot(),
  projectRoot,
  workflowsRoot,
  agentsRoot,
  flueRunId,
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
  const activeBuiltInStepRegistry =
    dependencies.builtInStepRegistry ?? defaultBuiltInStepRegistry;
  let workflowId: string | undefined;
  let workflowMode:
    | "git_managed_read_only"
    | "git_managed_write"
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
    workflowId = workflowIdFromRoute(
      invocation,
      configs.routing,
      dependencies
    );
    const workflow = await loadConfiguredWorkflow(
      resolvedWorkflowsRoot,
      workflowId
    );
    workflowObservabilityConfig = workflow.observability;
    workflowMode = workflow.mode;
    run = makeRunIdentity(invocation, {
      workflowId,
      attempt,
      date,
      flueRunId,
      nonce
    });
    artifactStore = new Store(
      artifactRootForWorkflow(configs.app.artifacts.root, workflowId),
      run.run_id
    );
    await artifactStore.initializeRunDirectory();
    await artifactStore.writeJson("invocation.json", invocation);
    await artifactStore.writeJson("run.json", run);
    ({ observability, summary } = await createRunObservability({
      artifactStore,
      run,
      workflowId,
      observabilityConfig: workflowObservabilityConfig,
      sinks: observabilitySinks
    }));
    await observability.emit(runStartedEvent(observability.eventContext("info")));
    await observability.emit(
      customEvent({
        ...observability.eventContext("info"),
        type: "luna.run.routed",
        outcome: { status: "succeeded" }
      })
    );

    repository = resolveRepository(
      invocation,
      configs.repositories.repositories
    );
    const configuredLockRoot = configs.app.locks?.root ?? ".luna/locks";
    const runtimeRoot = projectRoot ?? process.cwd();
    const lockRoot = path.isAbsolute(configuredLockRoot)
      ? configuredLockRoot
      : path.resolve(runtimeRoot, configuredLockRoot);
    const createLockManager =
      dependencies.lockManagerFactory ??
      ((options: RunLockManagerOptions) => new RunLockManager(options));
    lockManager = createLockManager({
      root: lockRoot,
      runId: run.run_id,
      flueRunId: run.flue_run_id,
      timeoutMs:
        workflow.execution.lock_timeout_ms ??
        configs.app.locks?.timeout_ms ??
        120000,
      staleAfterMs: configs.app.locks?.stale_after_ms ?? 600000,
      observability
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
      steps: {}
    };
    const orderedNodes = topologicalNodes(workflow.graph.nodes);
    const { mainNodes, deferredNodes: deferredFinalReportNodes } =
      splitDeferredFinalReportNodes(
        orderedNodes,
        (node) => builtInMetadata(node, activeBuiltInStepRegistry)
    );
    const activeArtifactStore = artifactStore;
    const nodeRuntimeContext: WorkflowNodeRuntimeContext = {
      dependencies,
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
      runNode: async ({ node, state }) =>
        await runWorkflowNode(node, state, nodeRuntimeContext),
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

    Object.assign(state.steps, scheduleResult.steps);
    workspaceRecord = scheduleResult.workspace;
    if (scheduleResult.workspace !== undefined) {
      persistedWorkspaceRecord = scheduleResult.workspace;
      state.workspace = scheduleResult.workspace;
    }

    if (scheduleResult.status === "failed") {
      const primaryFailure = firstSchedulerFailure(scheduleResult.steps);
      const error = configuredWorkflowError(
        "Workflow scheduler failed",
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
        steps: state.steps,
        success: true
      }),
      run: async () =>
        await finalizeSuccessWorkspace({
          artifactStore: successArtifactStore,
          workspaceRecord,
          persistedWorkspaceRecord,
          repository,
          workspaceConfig: configs.app.workspace,
          workflowMode: workflow.mode,
          implementationConfig: configs.runtimeConfig.implementation,
          steps: state.steps,
          cleanupWorktree
        })
    });
    if (finalWorkspace !== undefined) {
      workspaceRecord = finalWorkspace;
      state.workspace = finalWorkspace;
    }

    let report: JsonValue | undefined;
    for (const node of deferredFinalReportNodes) {
      const output = await runWorkflowNode(node, state, {
        ...nodeRuntimeContext,
        artifactStore
      });

      await writePlannedArtifacts({
        artifactStore,
        node,
        output,
        state
      });
      state.steps[node.id] = output;
      report = finalReportFrom(output) ?? report;
    }

    await observability.emit(
      runCompletedEvent({
        ...observability.eventContext("info"),
        status: "succeeded"
      })
    );
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
    const failedWorkspace = (error as { workspaceRecord?: unknown })
      .workspaceRecord;
    if (isWorkspaceRecord(failedWorkspace)) {
      workspaceRecord = failedWorkspace;
    }

    const failure = await ensureFailureArtifactStore({
      artifactStore,
      Store,
      configs,
      run,
      makeRunIdentity,
      invocation,
      workflowId,
      attempt,
      date,
      flueRunId,
      nonce
    });
    artifactStore = failure.artifactStore;
    run = failure.run;
    workflowId = failure.workflowId;
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
        await observability.emit(
          runCompletedEvent({
            ...observability.eventContext("error"),
            status: "failed",
            code: errorCode(error),
            data: sanitizeJsonObject({
              step_id: (error as { details?: ErrorArtifact["details"] })
                ?.details?.step_id,
              error
            })
          })
        );
      } catch {
        // Failure artifacts remain the source of truth if observability fails here.
      }
    }
    const artifact = errorArtifact(run.run_id, error);
    const artifactWriteError = await writeJsonBestEffort(
      artifactStore,
      "error.json",
      artifact
    );
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
            workflowMode: workflowMode ?? "git_managed_read_only",
            implementationConfig: configs.runtimeConfig.implementation,
            steps: {},
            success: false
          }),
          run: async () =>
            await finalizeFailureWorkspace({
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
