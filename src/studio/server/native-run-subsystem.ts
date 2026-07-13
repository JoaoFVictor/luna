import path from "node:path";
import type { AppConfig } from "../../core/config/schemas.js";
import type { RouterDefinition } from "../../core/router/router-definition.js";
import type { LunaPlatform } from "../../platform/native/native-platform.js";
import type { NativeLunaPlatformRegistrations } from "../../platform/native/native-platform-registrations.js";
import { runNativeWorkflowTarget } from "../../platform/native/native-workflow-runner.js";
import { createFilesystemArtifactManifestStore } from "../../runtime/backends/filesystem/artifacts.js";
import { createFilesystemInterruptStore } from "../../runtime/backends/filesystem/interrupts.js";
import { StudioRunLaunchFacade } from "../application/runs/launch-facade.js";
import { StudioRunLaunchService } from "../application/runs/launch-service.js";
import type { StudioRunDiagnosticSink } from "../application/runs/diagnostics.js";
import type { StudioDraftAuthoringService } from "../application/drafts/authoring-service.js";
import { StudioRunOutputFixtureService } from "../application/drafts/run-output-fixture-service.js";
import { StudioDraftTestDataService } from "../application/drafts/manual-test-data-service.js";
import { RunGraphService } from "../application/runs/graph-service.js";
import { RunNodeOutputService } from "../application/runs/node-output-service.js";
import { StudioRunInterruptService } from "../application/runs/interrupt-service.js";
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
import { NativeStudioRunDefinitionSource } from "../adapters/native/run-definition-source.js";
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
  readonly drafts: Pick<StudioDraftAuthoringService, "get" | "patch">;
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
    const runtimeRoot = path.resolve(
      options.projectRoot,
      options.app?.artifacts.root ?? ".runs"
    );
    const interruptStore = createFilesystemInterruptStore({
      root: path.join(runtimeRoot, "interrupts")
    });
    const graphStore = new FilesystemRunGraphStore({
      root: path.join(options.projectRoot, ".luna", "studio", "run-graphs")
    });
    dispatcher = new NativeStudioRunDispatcher({
      projectRoot: options.projectRoot,
      configRoot: options.configRoot,
      ledger: store.ledger,
      graphStore,
      platform: options.platform,
      resume: {
        interrupts: interruptStore,
        platform: options.platform
      },
      runDiagnostics: options.diagnostics,
      runWorkflow: options.platform.runWorkflow ?? (async (input) =>
        await runNativeWorkflowTarget(input, { platform: options.platform }))
    });
    await dispatcher.initialize();

    const launchInput = new NativeStudioRunLaunchInput({
      projectRoot: options.projectRoot,
      configRoot: options.configRoot,
      platform: options.platform
    });
    const definitions = new NativeStudioRunDefinitionSource({
      projectRoot: options.projectRoot,
      configRoot: options.configRoot,
      platform: options.platform,
      drafts: options.drafts
    });
    const planner = new StudioRunLaunchService({
      resolver: new NativeStudioRunPlanResolver({
        projectRoot: options.projectRoot,
        configRoot: options.configRoot,
        platform: options.platform,
        definitions
      }),
      confirmations: new MemoryStudioRunConfirmations(),
      dispatcher
    });
    const graph = new RunGraphService({
      ledger: store.ledger,
      events: store.events,
      store: graphStore
    });
    const outputs = new RunNodeOutputService({
      graphs: graph,
      ledger: store.ledger,
      store: graphStore
    });
    const outputFixtures = new StudioRunOutputFixtureService({
      outputs,
      drafts: options.drafts,
      validator: definitions
    });
    const draftTestData = new StudioDraftTestDataService({
      drafts: options.drafts,
      definitions,
      outputs
    });
    const launch = new StudioRunLaunchFacade({
      planner,
      adapters: launchInput,
      routing: options.loadRouting,
      routingSimulator: options.routingSimulator,
      installedDefinitions: definitions,
      draftDefinitions: definitions,
      draftTestData
    });
    const artifactReader = createFilesystemArtifactReader({
      root: runtimeRoot,
      manifests: createFilesystemArtifactManifestStore({ root: runtimeRoot })
    });
    const runInterrupts = new StudioRunInterruptService({
      catalog: store.catalog,
      interrupts: interruptStore,
      artifacts: artifactReader,
      resumer: dispatcher
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
      runs: { catalog: store.catalog, events: store.events, graph, outputs },
      runInterrupts,
      outputFixtures,
      runLaunch: {
        plan: async (...input: Parameters<typeof launch.plan>) =>
          await launch.plan(...input),
        planDraftTest: async (
          ...input: Parameters<typeof launch.planDraftTest>
        ) => await launch.planDraftTest(...input),
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
