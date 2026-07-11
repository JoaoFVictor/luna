import path from "node:path";
import type { AppConfig } from "../../core/config/schemas.js";
import { loadNativeLunaPlatform } from "../../platform/native/native-platform-loader.js";
import { loadStudioAgentCatalog } from "../application/catalog/agent-catalog.js";
import { createStudioCapabilityCatalog } from "../application/catalog/capability-catalog.js";
import { withStudioCapabilityConsumers } from "../application/catalog/capability-consumers.js";
import { loadStudioWorkflowCatalog } from "../application/catalog/workflow-catalog.js";
import {
  listStudioInputAdapters,
  previewStudioInputAdapter
} from "../application/inputs/input-adapters.js";
import { previewStudioInputRoute } from "../application/inputs/input-route-preview.js";
import {
  type StudioAdapterPreviewPort
} from "../application/inputs/adapter-preview-port.js";
import { loadStudioRoutingDefinition } from "../application/routing/router-definition-loader.js";
import { isolatedStudioRoutingSimulationPort } from "../application/routing/routing-simulator.js";
import { createStudioExpressionService } from "../application/expressions/expression-evaluator.js";
import { createStudioSchemaValidationService } from "../application/schemas/schema-instance-validator.js";
import { MemoryStudioAgentTestConfirmations } from "../adapters/memory/agent-test-confirmations.js";
import {
  NativeStudioAgentTestResolver,
  NativeStudioAgentTestRunner
} from "../adapters/native/agent-test-bench.js";
import { createNativeStudioAdapterPreviews } from "../adapters/native/input-adapter-previews.js";
import { StudioAgentTestBenchService } from "../application/agents/test-bench-service.js";
import {
  type HistoricalRunReconciliationOptions
} from "../adapters/filesystem/historical-run-reconciler.js";
import {
  createProcessWarningRunDiagnosticSink,
  type StudioRunDiagnosticSink
} from "../application/runs/diagnostics.js";
import type { StudioServerServices } from "./studio-server.js";
import { createNativeStudioAuthoringServices } from "./native-authoring-services.js";
import { createNativeStudioDraftAuthoringSurface } from "./native-draft-authoring-surface.js";
import { createNativeStudioConfigurationSurface } from "./native-configuration-surface.js";
import { createNativeStudioResourceHistorySurface } from "./native-resource-history-surface.js";
import {
  createNativeStudioRunSubsystem,
  type NativeStudioRunPlatform
} from "./native-run-subsystem.js";

type NativeStudioPlatform = NativeStudioRunPlatform;

export type NativeStudioServicesOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly app?: AppConfig;
  readonly platform?: NativeStudioPlatform;
  readonly previews?: StudioAdapterPreviewPort;
  readonly runDiagnostics?: StudioRunDiagnosticSink;
  readonly stateRoot?: string;
  readonly historicalRunReconciliation?: HistoricalRunReconciliationOptions;
};

async function resolvePlatform(
  options: NativeStudioServicesOptions
): Promise<NativeStudioPlatform> {
  if (options.platform !== undefined) {
    return options.platform;
  }
  return await loadNativeLunaPlatform({
    projectRoot: options.projectRoot,
    configRoot: options.configRoot,
    ...(options.app === undefined ? {} : { app: options.app })
  });
}

export async function createNativeStudioServices(
  options: NativeStudioServicesOptions
): Promise<StudioServerServices> {
  const platform = await resolvePlatform(options);
  const previews =
    options.previews ??
    createNativeStudioAdapterPreviews({
      projectRoot: options.projectRoot,
      configRoot: options.configRoot,
      registry: platform.inputAdapterRegistry
    });
  const workflowsRoot = path.join(options.projectRoot, "workflows");
  const agentsRoot = path.join(options.projectRoot, "agents");
  const capabilityCatalog = createStudioCapabilityCatalog(
    platform.capabilityRegistry
  );
  const loadAgents = async () =>
    await loadStudioAgentCatalog({
      agentsRoot,
      capabilityRegistry: platform.capabilityRegistry
    });
  const loadWorkflows = async () =>
    await loadStudioWorkflowCatalog({
      workflowsRoot,
      loadOptions: {
        agentsRoot,
        capabilityRegistry: platform.capabilityRegistry
      }
    });
  const catalogs = {
    technical: () => capabilityCatalog.technical_fingerprint,
    presentation: () => capabilityCatalog.presentation_fingerprint
  };
  const authoring = createNativeStudioAuthoringServices({
    projectRoot: options.projectRoot,
    configRoot: options.configRoot,
    platform,
    technicalCatalogFingerprint: () =>
      capabilityCatalog.technical_fingerprint
  });
  await authoring.initialize();
  const draftAuthoring = createNativeStudioDraftAuthoringSurface({
    projectRoot: options.projectRoot,
    configRoot: options.configRoot,
    platform,
    authoring,
    catalogs
  });
  const agentTest = new StudioAgentTestBenchService({
    resolver: new NativeStudioAgentTestResolver({
      projectRoot: options.projectRoot,
      configRoot: options.configRoot,
      platform,
      drafts: draftAuthoring.service
    }),
    confirmations: new MemoryStudioAgentTestConfirmations(),
    runner: new NativeStudioAgentTestRunner()
  });
  const configuration = createNativeStudioConfigurationSurface({
    projectRoot: options.projectRoot,
    configRoot: options.configRoot,
    ...(options.app === undefined ? {} : { app: options.app }),
    platform,
    authoring,
    catalogs
  });
  const resourceHistory = createNativeStudioResourceHistorySurface({
    projectRoot: options.projectRoot,
    configRoot: options.configRoot,
    platform,
    authoring,
    catalogs
  });
  const expressionService = createStudioExpressionService();
  const schemaService = createStudioSchemaValidationService();
  const routingSimulator = isolatedStudioRoutingSimulationPort;
  const loadRouting = async () =>
    await loadStudioRoutingDefinition({
      configRoot: options.configRoot,
      ...(options.app === undefined ? {} : { app: options.app })
    });
  const runSubsystem = await createNativeStudioRunSubsystem({
    projectRoot: options.projectRoot,
    configRoot: options.configRoot,
    ...(options.app === undefined ? {} : { app: options.app }),
    platform,
    loadRouting,
    routingSimulator,
    diagnostics:
      options.runDiagnostics ?? createProcessWarningRunDiagnosticSink(),
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    ...(options.historicalRunReconciliation === undefined
      ? {}
      : { historicalRunReconciliation: options.historicalRunReconciliation })
  });

  return {
    queries: {
      capabilities: async () => {
        const [workflows, agents] = await Promise.all([
          loadWorkflows(),
          loadAgents()
        ]);
        return withStudioCapabilityConsumers({
          catalog: capabilityCatalog,
          workflows,
          agents
        });
      },
      agents: loadAgents,
      workflows: loadWorkflows
    },
    inputRouting: {
      listInputAdapters: () =>
        listStudioInputAdapters(platform.inputAdapterRegistry, previews),
      previewInputAdapter: async (_principal, request, signal) =>
        await previewStudioInputAdapter(request, {
          registry: platform.inputAdapterRegistry,
          previews,
          signal
        }),
      previewInputRoute: async (_principal, request, signal) =>
        await previewStudioInputRoute(request, {
          registry: platform.inputAdapterRegistry,
          previews,
          routing: await loadRouting(),
          routingSimulator,
          signal
        }),
      routingDefinition: loadRouting,
      simulateRouting: async (_principal, request, signal) =>
        await routingSimulator.simulate(request, await loadRouting(), { signal })
    },
    expressions: {
      evaluateExpression: async (_principal, request, signal) =>
        await expressionService.evaluate(request, signal)
    },
    schemas: {
      validateSchemaInstance: async (_principal, request, signal) =>
        await schemaService.validate(request, signal)
    },
    drafts: draftAuthoring.control,
    agentTest,
    configuration: configuration.control,
    resourceHistory: resourceHistory.control,
    runs: runSubsystem.runs,
    runLaunch: runSubsystem.runLaunch,
    artifacts: runSubsystem.artifacts,
    runLogs: runSubsystem.runLogs,
    dispose: runSubsystem.dispose
  };
}
