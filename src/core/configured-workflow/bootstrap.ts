import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../artifact-store.js";
import {
  loadOptionalYamlFile,
  loadYamlFile
} from "../config-loader.js";
import { configuredWorkflowError } from "../configured-workflow-errors.js";
import { createObservabilitySinks } from "../observability/exporter-config.js";
import { createJsonlEventSink } from "../observability/jsonl-sink.js";
import {
  createLunaObservability,
  type LunaObservability,
  type LunaObservabilitySink
} from "../observability/luna-observability.js";
import {
  createObservabilitySummary,
  writeSummaryBestEffort,
  type ObservabilitySummary
} from "../observability/summary.js";
import { assertSafeSegment } from "../path-security.js";
import { routeInvocation as defaultRouteInvocation } from "../router.js";
import type { RunIdentityOptions } from "../run-identity.js";
import {
  AppConfigSchema,
  ModelsConfigSchema,
  RepositoriesConfigSchema,
  RoutingConfigSchema,
  type AppConfig,
  type Invocation,
  type ModelsConfig,
  type RepositoriesConfig,
  type RouteTarget,
  type RuntimeConfigState,
  type RoutingConfig,
  type RunIdentity
} from "../types.js";
import {
  defaultWorkflowObservabilityConfig,
  type WorkflowDefinition,
  type WorkflowObservabilityConfig
} from "../workflow/definition.js";
import {
  resolveModelProfiles,
  type ResolvedModelProfiles
} from "../model-config.js";
import { ImplementationConfigSchema } from "../write-mode/types.js";
import type { ConfiguredWorkflowBootstrap } from "./contracts.js";
import { loadConfiguredWorkflowDefinition } from "./workflow-definition-compatibility.js";

export type ConfiguredWorkflowBootstrapDependencies = {
  createRunIdentity: (
    invocation: Invocation,
    options: RunIdentityOptions
  ) => RunIdentity;
  routeInvocation?: typeof defaultRouteInvocation;
  ArtifactStore: typeof ArtifactStore;
};

export type ConfiguredWorkflowBootstrapConfigs = {
  app: AppConfig;
  repositories: RepositoriesConfig;
  routing: RoutingConfig;
  models: ModelsConfig;
  runtimeConfig: RuntimeConfigState;
};

export async function loadConfigs(
  configRoot: string
): Promise<ConfiguredWorkflowBootstrapConfigs> {
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
  dependencies: Pick<ConfiguredWorkflowBootstrapDependencies, "routeInvocation">
): string {
  const routeInvocation = dependencies.routeInvocation ?? defaultRouteInvocation;
  const target: RouteTarget = routeInvocation(invocation, routing);

  return target.id;
}

async function loadConfiguredWorkflow(
  workflowsRoot: string,
  workflowId: string
): Promise<WorkflowDefinition> {
  try {
    return await loadConfiguredWorkflowDefinition(workflowsRoot, workflowId);
  } catch (cause) {
    const error = configuredWorkflowError(
      `Failed to load workflow configuration: ${workflowId}`,
      "workflow_config_read_failed",
      cause
    );
    (error as Error & { workflowId?: string }).workflowId = workflowId;
    throw error;
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

export async function resolveConfiguredDirectoryRoot(
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

export function artifactRootForWorkflow(
  root: string,
  workflowId: string
): string {
  assertSafeSegment(workflowId);
  return path.join(root, workflowId);
}

export function createRunNonce(): string {
  return randomBytes(4).toString("hex");
}

export async function createRunObservability({
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
      runtimeRunId: run.flue_run_id,
      attempt: run.attempt
    },
    workflow: { id: workflowId },
    sinks: createObservabilitySinks({
      config: observabilityConfig,
      jsonlSink,
      runtimeLogSinks: sinks
    })
  });

  await writeSummaryBestEffort(artifactStore, summary);

  return { observability, summary };
}

export type ConfiguredWorkflowBootstrapOptions = {
  invocation: Invocation;
  configRoot: string;
  workflowsRoot?: string;
  agentsRoot?: string;
  runtimeRunId?: string;
  observabilitySinks: LunaObservabilitySink[];
  dependencies: ConfiguredWorkflowBootstrapDependencies;
  attempt: number;
  date: Date;
  nonce: string;
  configs?: ConfiguredWorkflowBootstrapConfigs;
};

export type ConfiguredWorkflowBootstrapResult = {
  configs: ConfiguredWorkflowBootstrapConfigs;
  workflow: WorkflowDefinition;
  workflowId: string;
  run: RunIdentity;
  artifactStore: ArtifactStore;
  observability: LunaObservability;
  summary: ObservabilitySummary;
  modelProfiles: ResolvedModelProfiles;
  resolvedAgentsRoot: string;
  workflowObservabilityConfig: WorkflowObservabilityConfig;
};

async function bootstrapConfiguredWorkflowRun({
  invocation,
  configRoot,
  workflowsRoot,
  agentsRoot,
  runtimeRunId,
  observabilitySinks,
  dependencies,
  attempt,
  date,
  nonce,
  configs
}: ConfiguredWorkflowBootstrapOptions): Promise<ConfiguredWorkflowBootstrapResult> {
  const activeConfigs = configs ?? (await loadConfigs(configRoot));
  const modelProfiles = resolveModelProfiles(activeConfigs.models);
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
  const workflowId = workflowIdFromRoute(
    invocation,
    activeConfigs.routing,
    dependencies
  );
  const workflow = await loadConfiguredWorkflow(
    resolvedWorkflowsRoot,
    workflowId
  );
  const workflowObservabilityConfig =
    workflow.observability ?? defaultWorkflowObservabilityConfig;
  const run = dependencies.createRunIdentity(invocation, {
    workflowId,
    attempt,
    date,
    runtimeRunId,
    nonce
  });
  const artifactStore = new dependencies.ArtifactStore(
    artifactRootForWorkflow(activeConfigs.app.artifacts.root, workflowId),
    run.run_id
  );
  await artifactStore.initializeRunDirectory();
  await artifactStore.writeJson("invocation.json", invocation);
  await artifactStore.writeJson("run.json", run);
  const { observability, summary } = await createRunObservability({
    artifactStore,
    run,
    workflowId,
    observabilityConfig: workflowObservabilityConfig,
    sinks: observabilitySinks
  });

  return {
    configs: activeConfigs,
    workflow,
    workflowId,
    run,
    artifactStore,
    observability,
    summary,
    modelProfiles,
    resolvedAgentsRoot,
    workflowObservabilityConfig
  };
}

export const configuredWorkflowBootstrap: ConfiguredWorkflowBootstrap = {
  bootstrap: bootstrapConfiguredWorkflowRun
};
