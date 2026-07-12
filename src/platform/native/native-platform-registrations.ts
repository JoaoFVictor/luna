import {
  officialCapabilityManifests,
  officialCapabilityRegistry
} from "../../capabilities/registry.js";
import type { InputAdapterRegistry } from "../../adapters/registry.js";
import type { RegisteredInputAdapter } from "../../adapters/types.js";
import {
  createCapabilityRegistry,
  type CapabilityRegistry
} from "../../core/capabilities/registry.js";
import type { CapabilityManifest } from "../../core/capabilities/manifest.js";
import type { TaskProviderBuiltIns } from "../../providers/built-ins.js";
import type { ChangeRequestProviderFactory } from "../../capabilities/change-request/contracts.js";
import type { PullRequestReviewProviderFactory } from "../../capabilities/pull-request-review/contracts.js";
import type { WebhookProviderAdapterFactory } from "../../webhooks/contracts.js";
import {
  defineWebhookProviderAdapterFactories,
  type WebhookProviderRegistry
} from "../../webhooks/provider-registry.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput,
  WorkflowPatternExecutor,
  WorkflowRunResult
} from "../../core/workflow/execution-contracts.js";
import type { WorkflowRuntimeFactory } from "../../core/workflow/runner-port.js";
import type {
  AgentRuntimeFactory
} from "../../runtime/composition/runtime-composition.js";
import { defineInputAdapters } from "../../adapters/registry.js";
import {
  nativePlatformPlugins,
  type NativePlatformPluginRegistration,
  type NativeWorkflowBuiltIns
} from "./native-platform-plugins.js";
import {
  taskProviderBuiltInsFromPlugins,
  workflowBuiltInsFromPlugins
} from "./native-built-ins.js";
import {
  defineProviderHealthProbes,
  type ProviderHealthProbeRegistry
} from "../../core/providers/health-probe-registry.js";

export type NativeLunaPlatformRegistrations = {
  readonly inputAdapterRegistry: InputAdapterRegistry<RegisteredInputAdapter>;
  readonly agentRuntimeFactories: Readonly<Record<string, AgentRuntimeFactory>>;
  readonly workflowRuntimeFactories: Readonly<Record<
    string,
    WorkflowRuntimeFactory<RunWorkflowInput, ResumeWorkflowInput, WorkflowRunResult>
  >>;
  readonly workflowBuiltIns?: NativeWorkflowBuiltIns;
  readonly taskProviderBuiltIns?: Readonly<Record<string, TaskProviderBuiltIns>>;
  readonly patternExecutors?: Readonly<Record<string, WorkflowPatternExecutor>>;
  readonly changeRequestProviderFactories: readonly ChangeRequestProviderFactory[];
  readonly pullRequestReviewProviderFactories: readonly PullRequestReviewProviderFactory[];
  readonly webhookProviderRegistry: WebhookProviderRegistry<WebhookProviderAdapterFactory>;
  readonly providerHealthProbeRegistry: ProviderHealthProbeRegistry;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly capabilityManifests: readonly CapabilityManifest[];
};

export type NativePlatformRegistrationError = Error & {
  code: "native_platform_registration_invalid";
};

function nativePlatformRegistrationError(
  message: string
): NativePlatformRegistrationError {
  const error = new Error(message) as NativePlatformRegistrationError;
  error.code = "native_platform_registration_invalid";
  return error;
}

export function createNativeLunaPlatformRegistrations({
  plugins = nativePlatformPlugins,
  baseCapabilityManifests = officialCapabilityManifests
}: {
  readonly plugins?: readonly NativePlatformPluginRegistration[];
  readonly baseCapabilityManifests?: readonly CapabilityManifest[];
} = {}): NativeLunaPlatformRegistrations {
  const capabilityManifests = [
    ...baseCapabilityManifests,
    ...plugins.flatMap((plugin) => plugin.capabilityManifests ?? [])
  ];
  const hasPluginCapabilityManifests = plugins.some(
    (plugin) => (plugin.capabilityManifests ?? []).length > 0
  );

  return {
    inputAdapterRegistry: defineInputAdapters(
      plugins.flatMap((plugin) => plugin.inputAdapters ?? [])
    ),
    agentRuntimeFactories: mergePluginRecords(
      plugins,
      "agent runtime",
      (plugin) => plugin.agentRuntimeFactories
    ),
    workflowRuntimeFactories: mergePluginRecords(
      plugins,
      "workflow runtime",
      (plugin) => plugin.workflowRuntimeFactories
    ),
    workflowBuiltIns: workflowBuiltInsFromPlugins(plugins),
    taskProviderBuiltIns: taskProviderBuiltInsFromPlugins(plugins),
    patternExecutors: mergePluginRecords(
      plugins,
      "pattern executor",
      (plugin) => plugin.patternExecutors
    ),
    changeRequestProviderFactories: Object.freeze(
      plugins.flatMap((plugin) => plugin.changeRequestProviderFactories ?? [])
    ),
    pullRequestReviewProviderFactories: Object.freeze(
      plugins.flatMap((plugin) => plugin.pullRequestReviewProviderFactories ?? [])
    ),
    webhookProviderRegistry: defineWebhookProviderAdapterFactories(
      plugins.flatMap((plugin) => plugin.webhookAdapterFactories ?? [])
    ),
    providerHealthProbeRegistry: defineProviderHealthProbes(
      plugins.flatMap((plugin) =>
        plugin.providerHealthProbe === undefined
          ? []
          : [plugin.providerHealthProbe]
      )
    ),
    capabilityRegistry:
      baseCapabilityManifests === officialCapabilityManifests &&
      !hasPluginCapabilityManifests
        ? officialCapabilityRegistry
        : createCapabilityRegistry(capabilityManifests),
    capabilityManifests
  };
}

export const nativeLunaPlatformRegistrations = createNativeLunaPlatformRegistrations();

function mergePluginRecords<TValue>(
  plugins: readonly NativePlatformPluginRegistration[],
  label: string,
  select: (
    plugin: NativePlatformPluginRegistration
  ) => Readonly<Record<string, TValue>> | undefined
): Readonly<Record<string, TValue>> {
  const merged: Record<string, TValue> = {};
  for (const plugin of plugins) {
    const record = select(plugin);
    if (record === undefined) {
      continue;
    }

    for (const id of Object.keys(record)) {
      if (merged[id] !== undefined) {
        throw nativePlatformRegistrationError(`Duplicate native ${label} id: ${id}`);
      }
      merged[id] = record[id];
    }
  }

  return Object.freeze(merged);
}
