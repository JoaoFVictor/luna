import path from "node:path";
import type { AppConfig } from "../../core/config/schemas.js";
import type { RouterDefinition } from "../../core/router/router-definition.js";
import type { LunaPlatform } from "../../platform/native/native-platform.js";
import type { NativeLunaPlatformRegistrations } from "../../platform/native/native-platform-registrations.js";
import { runNativeWorkflowTarget } from "../../platform/native/native-workflow-runner.js";
import { createFilesystemArtifactManifestStore } from "../../runtime/backends/filesystem/artifacts.js";
import { StudioRunLaunchFacade } from "../application/runs/launch-facade.js";
import { StudioRunLaunchService } from "../application/runs/launch-service.js";
import type { StudioRunDiagnosticSink } from "../application/runs/diagnostics.js";
import { RunGraphService } from "../application/runs/graph-service.js";
import type { StudioRoutingSimulationPort } from "../application/routing/routing-simulator.js";
import { createFilesystemArtifactReader } from "../adapters/filesystem/artifact-reader.js";
import {
  FilesystemHistoricalRunReconciler,
  type HistoricalRunReconciliationOptions
} from "../adapters/filesystem/historical-run-reconciler.js";
import { FilesystemRunGraphStore } from "../adapters/filesystem/run-graph-store.js";
import { createFilesystemRunLogReader } from "../adapters/filesystem/run-log-reader.js";
import { MemoryStudioRunConfirmations } from "../adapters/memory/run-confirmations.js";
import { NativeStudioRunDispatcher } from "../adapters/native/run-dispatcher.js";
import { NativeStudioRunLaunchInput } from "../adapters/native/run-launch-input.js";
import { NativeStudioRunPlanResolver } from "../adapters/native/run-plan-resolver.js";
import { createSqliteRunStore, type SqliteRunStore } from "../adapters/sqlite/run-store.js";
import { onceStudioServiceDisposer } from "./service-lifecycle.js";
import {
  assertStudioStateRootOutsideProject,
  studioProjectStateRoot
} from "./studio-state-root.js";

export type NativeStudioRunPlatform = NativeLunaPlatformRegistrations &
  Partial<Pick<LunaPlatform, "runWorkflow">>;

export type NativeStudioRunSubsystemOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly app?: AppConfig;
  readonly platform: NativeStudioRunPlatform;
  readonly loadRouting: () => Promise<RouterDefinition>;
  readonly routingSimulator: StudioRoutingSimulationPort;
  readonly diagnostics: StudioRunDiagnosticSink;
  readonly stateRoot?: string;
  readonly historicalRunReconciliation?: HistoricalRunReconciliationOptions;
};

async function releaseRunResources(input: {
  readonly historicalRuns?: FilesystemHistoricalRunReconciler;
  readonly dispatcher?: NativeStudioRunDispatcher;
  readonly store: SqliteRunStore;
}): Promise<void> {
  let failure: unknown;
  try {
    await input.historicalRuns?.close();
  } catch (cause) {
    failure = cause;
  }
  try {
    await input.dispatcher?.close();
  } catch (cause) {
    failure ??= cause;
  }
  try {
    input.store.close();
  } catch (cause) {
    failure ??= cause;
  }
  if (failure !== undefined) {
    throw failure;
  }
}

export async function createNativeStudioRunSubsystem(
  options: NativeStudioRunSubsystemOptions
) {
  const stateRoot = assertStudioStateRootOutsideProject(
    options.projectRoot,
    options.stateRoot ?? studioProjectStateRoot(options.projectRoot)
  );
  const store = await createSqliteRunStore({
    filePath: path.join(stateRoot, "runs.sqlite")
  });
  let dispatcher: NativeStudioRunDispatcher | undefined;
  let historicalRuns: FilesystemHistoricalRunReconciler | undefined;
  try {
    const graphStore = new FilesystemRunGraphStore({
      root: path.join(options.projectRoot, ".luna", "studio", "run-graphs")
    });
    dispatcher = new NativeStudioRunDispatcher({
      projectRoot: options.projectRoot,
      configRoot: options.configRoot,
      ledger: store.ledger,
      graphStore,
      platform: options.platform,
      runDiagnostics: options.diagnostics,
      runWorkflow: options.platform.runWorkflow ?? (async (input) =>
        await runNativeWorkflowTarget(input, { platform: options.platform }))
    });
    await dispatcher.initialize();

    const planner = new StudioRunLaunchService({
      resolver: new NativeStudioRunPlanResolver({
        projectRoot: options.projectRoot,
        configRoot: options.configRoot,
        platform: options.platform
      }),
      confirmations: new MemoryStudioRunConfirmations(),
      dispatcher
    });
    const graph = new RunGraphService({ ledger: store.ledger, store: graphStore });
    const launchInput = new NativeStudioRunLaunchInput({
      projectRoot: options.projectRoot,
      configRoot: options.configRoot,
      platform: options.platform
    });
    const launch = new StudioRunLaunchFacade({
      planner,
      adapters: launchInput,
      routing: options.loadRouting,
      routingSimulator: options.routingSimulator,
      installedDefinitions: launchInput
    });
    const runtimeRoot = path.resolve(
      options.projectRoot,
      options.app?.artifacts.root ?? ".runs"
    );
    const artifactReader = createFilesystemArtifactReader({
      root: runtimeRoot,
      manifests: createFilesystemArtifactManifestStore({ root: runtimeRoot })
    });
    const runLogReader = createFilesystemRunLogReader({ root: runtimeRoot });
    historicalRuns = new FilesystemHistoricalRunReconciler({
      root: runtimeRoot,
      reconciler: store.reconciler,
      knownRuns: store.ledger,
      diagnostics: options.diagnostics,
      ...(options.historicalRunReconciliation === undefined
        ? {}
        : { options: options.historicalRunReconciliation })
    });
    await historicalRuns.initialize();

    return {
      runs: { catalog: store.catalog, events: store.events, graph },
      runLaunch: {
        plan: async (...input: Parameters<typeof launch.plan>) =>
          await launch.plan(...input),
        execute: async (...input: Parameters<typeof planner.execute>) =>
          await planner.execute(...input)
      },
      artifacts: { catalog: store.catalog, reader: artifactReader },
      runLogs: { catalog: store.catalog, reader: runLogReader },
      dispose: onceStudioServiceDisposer(async () => {
        await releaseRunResources({ historicalRuns, dispatcher, store });
      })
    };
  } catch (cause) {
    try {
      await releaseRunResources({ historicalRuns, dispatcher, store });
    } catch {
      // Preserve the authoritative construction failure.
    }
    throw cause;
  }
}
