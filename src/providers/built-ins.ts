import { createBuiltInStepCatalog } from "../core/built-ins/catalog.js";
import { builtInError } from "../core/built-ins/errors.js";
import { defineBuiltInStep } from "../core/built-ins/registry.js";
import { finalReportMetadata } from "../core/built-ins/metadata.js";
import type { Invocation } from "../core/router/invocation.js";
import type {
  BuiltInStep,
  BuiltInStepDependencies,
  BuiltInStepRunOptions,
  MaybePromise
} from "../core/built-ins/types.js";
import type {
  WorkflowBuiltInExecutor,
} from "../core/workflow/execution-contracts.js";
import type { WorkflowRuntimeContext } from "../core/workflow/runtime-context.js";
import type { LunaRuntimeState } from "../core/runtime/state.js";

export type TaskProviderBuiltIns = {
  collectTaskContext(options: BuiltInStepRunOptions): MaybePromise<unknown>;
  finalImplementationReport(options: BuiltInStepRunOptions): MaybePromise<unknown>;
};

export type TaskProviderBuiltInEntry = {
  readonly source: string;
  readonly builtIns: TaskProviderBuiltIns;
};

export type ProviderBuiltInCatalog = ReturnType<typeof createProviderBuiltIns>;

function invocationSourceFrom(state: { invocation?: unknown }): string {
  const source = (state.invocation as Partial<Invocation> | undefined)?.source;

  if (typeof source !== "string" || source.length === 0) {
    throw builtInError(
      "Built-in step requires invocation.source",
      "built_in_unsupported"
    );
  }

  return source;
}

export function defineTaskProviderBuiltIns(
  entries: readonly TaskProviderBuiltInEntry[]
): Readonly<Record<string, TaskProviderBuiltIns>> {
  const providers: Record<string, TaskProviderBuiltIns> = {};

  for (const entry of entries) {
    if (providers[entry.source] !== undefined) {
      throw builtInError(
        `Duplicate task provider built-ins for source: ${entry.source}`,
        "built_in_duplicate"
      );
    }

    providers[entry.source] = entry.builtIns;
  }

  return providers;
}

export function createCollectTaskContextBuiltIn(
  taskProviderBuiltIns: Readonly<Record<string, TaskProviderBuiltIns>>
): BuiltInStep<"task-context.collect"> {
  return defineBuiltInStep({
    name: "task-context.collect",
    run(options) {
      const source = invocationSourceFrom(options.state);
      const provider = taskProviderBuiltIns[source];

      if (provider !== undefined) {
        return provider.collectTaskContext(options);
      }

      throw builtInError(
        `Built-in step does not support task context for source: ${source}`,
        "built_in_unsupported"
      );
    }
  });
}

export function createFinalImplementationReportBuiltIn(
  taskProviderBuiltIns: Readonly<Record<string, TaskProviderBuiltIns>>
): BuiltInStep<"task-context.final_report"> {
  return defineBuiltInStep({
    name: "task-context.final_report",
    metadata: finalReportMetadata,
    run(options) {
      const source = invocationSourceFrom(options.state);
      const provider = taskProviderBuiltIns[source];

      if (provider !== undefined) {
        return provider.finalImplementationReport(options);
      }

      throw builtInError(
        `Built-in step does not support implementation reports for source: ${source}`,
        "built_in_unsupported"
      );
    }
  });
}

export function createProviderBuiltIns({
  steps,
  dependencies = {}
}: {
  readonly steps: readonly BuiltInStep[];
  readonly dependencies?: BuiltInStepDependencies;
}) {
  const builtInSteps = Object.freeze([...steps] as const);
  const catalog = createBuiltInStepCatalog(builtInSteps);

  function workflowBuiltIns(
    extraDependencies: BuiltInStepDependencies = {}
  ): Record<string, WorkflowBuiltInExecutor> {
    const resolvedDependencies = {
      ...dependencies,
      ...extraDependencies
    };
    const entries: Array<[string, WorkflowBuiltInExecutor]> = [];
    for (const name of catalog.names) {
      entries.push([name, workflowExecutorFor(catalog, name, resolvedDependencies)]);
    }

    return Object.fromEntries(entries);
  }

  return {
    builtInSteps,
    builtInStepNames: catalog.names,
    builtInStepRegistry: catalog.registry,
    isBuiltInStepName: catalog.isBuiltInStepName,
    runBuiltInStep: catalog.runBuiltInStep,
    workflowBuiltIns
  };
}

function workflowExecutorFor(
  catalog: ReturnType<typeof createBuiltInStepCatalog<readonly BuiltInStep[]>>,
  name: string,
  dependencies: BuiltInStepDependencies
): WorkflowBuiltInExecutor {
  return async ({ state, input, runtimeContext, observabilitySummary }) =>
    await catalog.runBuiltInStep({
      uses: name,
      state: workflowStateView(state, runtimeContext),
      input: workflowBuiltInInput(input),
      dependencies,
      observabilitySummary
    });
}

function workflowBuiltInInput(
  input: unknown
): Record<string, unknown> | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  throw builtInError(
    "Workflow built-in input must resolve to an object",
    "built_in_input_invalid"
  );
}

function workflowStateView(
  state: LunaRuntimeState,
  runtimeContext: WorkflowRuntimeContext
): LunaRuntimeState & {
  repository?: unknown;
  workspaceRoot?: string;
  agentsRoot?: string;
  workspace?: unknown;
  lifecycleEvidence?: unknown;
} {
  return {
    ...state,
    ...(runtimeContext.repository === undefined ? {} : { repository: runtimeContext.repository }),
    ...(runtimeContext.workspaceRoot === undefined ? {} : { workspaceRoot: runtimeContext.workspaceRoot }),
    ...(runtimeContext.agentsRoot === undefined ? {} : { agentsRoot: runtimeContext.agentsRoot }),
    ...(runtimeContext.workspace === undefined ? {} : { workspace: runtimeContext.workspace }),
    ...(runtimeContext.lifecycleEvidence === undefined ? {} : { lifecycleEvidence: runtimeContext.lifecycleEvidence })
  };
}
