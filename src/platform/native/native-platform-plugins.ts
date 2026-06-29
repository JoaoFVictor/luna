import type {
  AgentRuntimeFactory
} from "../../runtime/composition/runtime-composition.js";
import type {
  ResumeWorkflowInput,
  RunWorkflowInput,
  WorkflowPatternExecutor,
  WorkflowRunResult
} from "../../core/workflow/execution-contracts.js";
import type { WorkflowRuntimeFactory } from "../../core/workflow/runner-port.js";
import type { CapabilityManifest } from "../../core/capabilities/manifest.js";
import type {
  AdapterContext,
  AdapterInput,
  InputAdapter,
  RegisteredInputAdapter
} from "../../adapters/types.js";
import type { BuiltInStep } from "../../core/built-ins/types.js";
import type { ChangeRequestProviderFactory } from "../../capabilities/change-request/contracts.js";
import type { WebhookProviderAdapterFactory } from "../../webhooks/contracts.js";
import { githubPrUrlAdapter } from "../../providers/github/input-adapter.js";
import { githubWebhookAdapterFactory } from "../../providers/github/webhook-adapter.js";
import { preflightBuiltIn } from "../../capabilities/runtime/built-ins.js";
import { createGitHubChangeRequestProviderFactory } from "../../providers/github/change-request/factory.js";
import { jiraTaskUrlAdapter } from "../../providers/jira/input-adapter.js";
import {
  collectTaskContext as collectJiraTaskContext,
  finalImplementationReport as finalJiraImplementationReport
} from "../../providers/jira/built-ins.js";
import { planeTaskUrlAdapter } from "../../providers/plane/input-adapter.js";
import { planeWebhookAdapterFactory } from "../../providers/plane/webhook-adapter.js";
import {
  collectTaskContext as collectPlaneTaskContext,
  finalImplementationReport as finalPlaneImplementationReport
} from "../../providers/plane/built-ins.js";
import type { TaskProviderBuiltIns } from "../../providers/built-ins.js";
import { piAgentRuntimeFactory } from "../../agent-runtimes/pi/factory.js";
import { langGraphWorkflowRuntimeFactory } from "../../runtime/langgraph/workflow-runner.js";
import { collectWorktreeDiff } from "../../capabilities/git/diff/worktree-diff.js";
import { createQualityGatePatternExecutors } from "../../capabilities/quality-gates/workflow-pattern-executor.js";
import { runValidationCommands } from "../../capabilities/validation/command-runner.js";

export type NativeWorkflowBuiltIns = {
  readonly beforeContext?: readonly BuiltInStep[];
  readonly afterContext?: readonly BuiltInStep[];
  readonly builtIns?: readonly BuiltInStep[];
};

export type NativeWorkflowBuiltInHooks = {
  readonly beforeContext?: readonly BuiltInStep[];
  readonly afterContext?: readonly BuiltInStep[];
};

export type NativePlatformInputAdapter =
  | InputAdapter
  | {
      readonly adapter: InputAdapter;
      readonly source: string;
    };

export type NativePlatformPlugin = {
  readonly id: string;
  readonly capabilityManifests?: readonly CapabilityManifest[];
  readonly inputAdapters?: readonly NativePlatformInputAdapter[];
  readonly agentRuntimeFactories?: Readonly<Record<string, AgentRuntimeFactory>>;
  readonly workflowRuntimeFactories?: Readonly<Record<
    string,
    WorkflowRuntimeFactory<RunWorkflowInput, ResumeWorkflowInput, WorkflowRunResult>
  >>;
  readonly builtIns?: readonly BuiltInStep[];
  readonly workflowBuiltIns?: NativeWorkflowBuiltInHooks;
  readonly taskSource?: string;
  readonly taskBuiltIns?: TaskProviderBuiltIns;
  readonly patternExecutors?: Readonly<Record<string, WorkflowPatternExecutor>>;
  readonly changeRequestProviderFactories?: readonly ChangeRequestProviderFactory[];
  readonly webhookAdapterFactories?: readonly WebhookProviderAdapterFactory[];
};

export type NativePlatformPluginRegistration = Omit<
  NativePlatformPlugin,
  "inputAdapters"
> & {
  readonly inputAdapters?: readonly RegisteredInputAdapter[];
};

export type NativePlatformPluginError = Error & {
  code: "native_plugin_invalid";
};

function nativePlatformPluginError(message: string): NativePlatformPluginError {
  const error = new Error(message) as NativePlatformPluginError;
  error.code = "native_plugin_invalid";
  return error;
}

export function defineNativePlatformPlugins(
  plugins: readonly NativePlatformPlugin[]
): readonly NativePlatformPluginRegistration[] {
  const ids = new Set<string>();
  const adapterIds = new Set<string>();
  const agentRuntimeIds = new Set<string>();
  const workflowRuntimeIds = new Set<string>();
  const patternExecutorIds = new Set<string>();
  const webhookProviderIds = new Set<string>();
  const taskSources = new Set<string>();
  const registrations: NativePlatformPluginRegistration[] = [];

  for (const plugin of plugins) {
    if (plugin.id.trim() === "") {
      throw nativePlatformPluginError("Native plugin id cannot be empty");
    }
    if (ids.has(plugin.id)) {
      throw nativePlatformPluginError(`Duplicate native plugin id: ${plugin.id}`);
    }
    ids.add(plugin.id);
    const taskSource = plugin.taskSource ?? plugin.id;
    if (plugin.taskSource !== undefined && taskSource.trim() === "") {
      throw nativePlatformPluginError(`Native plugin ${plugin.id} has an empty task source`);
    }
    if (plugin.taskBuiltIns !== undefined) {
      if (taskSources.has(taskSource)) {
        throw nativePlatformPluginError(`Duplicate native task source: ${taskSource}`);
      }
      taskSources.add(taskSource);
    }
    assertUniqueRecordIds(plugin.agentRuntimeFactories, agentRuntimeIds, "agent runtime");
    assertUniqueRecordIds(plugin.workflowRuntimeFactories, workflowRuntimeIds, "workflow runtime");
    assertUniqueRecordIds(plugin.patternExecutors, patternExecutorIds, "pattern executor");
    for (const factory of plugin.webhookAdapterFactories ?? []) {
      if (webhookProviderIds.has(factory.id)) {
        throw nativePlatformPluginError(`Duplicate native webhook provider: ${factory.id}`);
      }
      webhookProviderIds.add(factory.id);
    }

    const inputAdapters = (plugin.inputAdapters ?? []).map((entry) => {
      const { adapter, source } = normalizeInputAdapter(entry, plugin.id);
      if (adapterIds.has(adapter.id)) {
        throw nativePlatformPluginError(`Duplicate native input adapter id: ${adapter.id}`);
      }
      adapterIds.add(adapter.id);

      return Object.freeze({
        ...adapter,
        source,
        async load(input: AdapterInput, context: AdapterContext) {
          const invocation = await adapter.load(input, context);
          if (invocation.source !== source) {
            throw nativePlatformPluginError(
              `Input adapter ${adapter.id} returned invocation source ${invocation.source} does not match registered source ${source}`
            );
          }

          return invocation;
        }
      });
    });

    registrations.push(Object.freeze({
      id: plugin.id,
      ...(plugin.capabilityManifests === undefined
        ? {}
        : { capabilityManifests: plugin.capabilityManifests }),
      ...(plugin.agentRuntimeFactories === undefined
        ? {}
        : { agentRuntimeFactories: plugin.agentRuntimeFactories }),
      ...(plugin.workflowRuntimeFactories === undefined
        ? {}
        : { workflowRuntimeFactories: plugin.workflowRuntimeFactories }),
      ...(plugin.workflowBuiltIns === undefined
        ? {}
        : { workflowBuiltIns: plugin.workflowBuiltIns }),
      ...(plugin.builtIns === undefined
        ? {}
        : { builtIns: plugin.builtIns }),
      ...(plugin.taskSource === undefined
        ? {}
        : { taskSource: plugin.taskSource }),
      ...(plugin.taskBuiltIns === undefined
        ? {}
        : { taskBuiltIns: plugin.taskBuiltIns }),
      ...(plugin.patternExecutors === undefined
        ? {}
        : { patternExecutors: plugin.patternExecutors }),
      ...(plugin.changeRequestProviderFactories === undefined
        ? {}
        : { changeRequestProviderFactories: plugin.changeRequestProviderFactories }),
      ...(plugin.webhookAdapterFactories === undefined
        ? {}
        : { webhookAdapterFactories: plugin.webhookAdapterFactories }),
      ...(inputAdapters.length === 0 ? {} : { inputAdapters })
    }));
  }

  return Object.freeze(registrations);
}

function normalizeInputAdapter(
  entry: NativePlatformInputAdapter,
  defaultSource: string
): { readonly adapter: InputAdapter; readonly source: string } {
  if ("adapter" in entry) {
    if (entry.source.trim() === "") {
      throw nativePlatformPluginError(
        `Input adapter ${entry.adapter.id} has an empty registered source`
      );
    }
    return { adapter: entry.adapter, source: entry.source };
  }

  return { adapter: entry, source: defaultSource };
}

function assertUniqueRecordIds(
  record: Readonly<Record<string, unknown>> | undefined,
  seen: Set<string>,
  label: string
): void {
  for (const id of Object.keys(record ?? {})) {
    if (seen.has(id)) {
      throw nativePlatformPluginError(`Duplicate native ${label} id: ${id}`);
    }
    seen.add(id);
  }
}

export const nativePlatformPluginDefinitions = [
  {
    id: "runtime",
    agentRuntimeFactories: {
      [piAgentRuntimeFactory.id]: piAgentRuntimeFactory
    },
    workflowRuntimeFactories: {
      [langGraphWorkflowRuntimeFactory.id]: langGraphWorkflowRuntimeFactory
    }
  },
  {
    id: "quality-gates",
    patternExecutors: createQualityGatePatternExecutors({
      runValidationCommands,
      collectDiffSummary: collectWorktreeDiff
    })
  },
  {
    id: "github",
    inputAdapters: [githubPrUrlAdapter],
    workflowBuiltIns: {
      beforeContext: [preflightBuiltIn],
      afterContext: []
    },
    changeRequestProviderFactories: [createGitHubChangeRequestProviderFactory({})],
    webhookAdapterFactories: [githubWebhookAdapterFactory]
  },
  {
    id: "jira",
    inputAdapters: [jiraTaskUrlAdapter],
    taskBuiltIns: {
      collectTaskContext: collectJiraTaskContext,
      finalImplementationReport: finalJiraImplementationReport
    }
  },
  {
    id: "plane",
    inputAdapters: [planeTaskUrlAdapter],
    taskBuiltIns: {
      collectTaskContext: collectPlaneTaskContext,
      finalImplementationReport: finalPlaneImplementationReport
    },
    webhookAdapterFactories: [planeWebhookAdapterFactory]
  }
] satisfies readonly NativePlatformPlugin[];

export const nativePlatformPlugins = defineNativePlatformPlugins(
  nativePlatformPluginDefinitions
);
