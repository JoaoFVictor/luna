import type {
  AdapterContext,
  AdapterInput,
  InputAdapter,
  RegisteredInputAdapter
} from "../../adapters/types.js";
import type { BuiltInStep } from "../../core/built-ins/types.js";
import type { ChangeRequestProviderFactory } from "../../core/change-request/contracts.js";
import { githubPrUrlAdapter } from "../../adapters/github-pr-url/index.js";
import {
  collectRepoContextBuiltIn,
  finalCodeReviewReportBuiltIn,
  preflightBuiltIn,
  prepareWorktreeBuiltIn,
  validateCodeReviewFindingsBuiltIn
} from "../../providers/github/built-ins.js";
import { createGitHubChangeRequestProviderFactory } from "../../providers/github/change-request/factory.js";
import { jiraTaskUrlAdapter } from "../../adapters/jira-task-url/index.js";
import {
  collectTaskContext as collectJiraTaskContext,
  finalImplementationReport as finalJiraImplementationReport
} from "../../providers/jira/built-ins.js";
import { planeTaskUrlAdapter } from "../../adapters/plane-task-url/index.js";
import {
  collectTaskContext as collectPlaneTaskContext,
  finalImplementationReport as finalPlaneImplementationReport
} from "../../providers/plane/built-ins.js";
import type { TaskProviderBuiltIns } from "../../providers/built-ins.js";

export type NativeWorkflowBuiltIns = {
  readonly beforeContext?: readonly BuiltInStep[];
  readonly afterContext?: readonly BuiltInStep[];
};

export type NativePlatformExtension = {
  readonly id: string;
  readonly inputAdapters?: readonly InputAdapter[];
  readonly workflowBuiltIns?: NativeWorkflowBuiltIns;
  readonly taskBuiltIns?: TaskProviderBuiltIns;
  readonly changeRequestProviderFactories?: readonly ChangeRequestProviderFactory[];
};

export type NativePlatformExtensionRegistration = Omit<
  NativePlatformExtension,
  "inputAdapters"
> & {
  readonly inputAdapters?: readonly RegisteredInputAdapter[];
};

export type NativePlatformExtensionError = Error & {
  code: "native_extension_invalid";
};

function nativePlatformExtensionError(message: string): NativePlatformExtensionError {
  const error = new Error(message) as NativePlatformExtensionError;
  error.code = "native_extension_invalid";
  return error;
}

export function defineNativePlatformExtensions(
  extensions: readonly NativePlatformExtension[]
): readonly NativePlatformExtensionRegistration[] {
  const ids = new Set<string>();
  const adapterIds = new Set<string>();
  const registrations: NativePlatformExtensionRegistration[] = [];

  for (const extension of extensions) {
    if (ids.has(extension.id)) {
      throw nativePlatformExtensionError(`Duplicate native platform extension id: ${extension.id}`);
    }
    ids.add(extension.id);

    const inputAdapters = (extension.inputAdapters ?? []).map((adapter) => {
      if (adapterIds.has(adapter.id)) {
        throw nativePlatformExtensionError(`Duplicate native input adapter id: ${adapter.id}`);
      }
      adapterIds.add(adapter.id);

      return Object.freeze({
        ...adapter,
        source: extension.id,
        async load(input: AdapterInput, context: AdapterContext) {
          const invocation = await adapter.load(input, context);
          if (invocation.source !== extension.id) {
            throw nativePlatformExtensionError(
              `Input adapter ${adapter.id} returned invocation source ${invocation.source} does not match extension ${extension.id}`
            );
          }

          return invocation;
        }
      });
    });

    registrations.push(Object.freeze({
      id: extension.id,
      ...(extension.workflowBuiltIns === undefined
        ? {}
        : { workflowBuiltIns: extension.workflowBuiltIns }),
      ...(extension.taskBuiltIns === undefined
        ? {}
        : { taskBuiltIns: extension.taskBuiltIns }),
      ...(extension.changeRequestProviderFactories === undefined
        ? {}
        : { changeRequestProviderFactories: extension.changeRequestProviderFactories }),
      ...(inputAdapters.length === 0 ? {} : { inputAdapters })
    }));
  }

  return Object.freeze(registrations);
}

export const nativePlatformExtensions = defineNativePlatformExtensions([
  {
    id: "github",
    inputAdapters: [githubPrUrlAdapter],
    workflowBuiltIns: {
      beforeContext: [preflightBuiltIn, prepareWorktreeBuiltIn],
      afterContext: [
        collectRepoContextBuiltIn,
        validateCodeReviewFindingsBuiltIn,
        finalCodeReviewReportBuiltIn
      ]
    },
    changeRequestProviderFactories: [createGitHubChangeRequestProviderFactory({})]
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
    }
  }
]);
