import path from "node:path";
import type { AppConfig } from "../../core/config/schemas.js";
import type { LunaPlatform } from "../../platform/native/native-platform.js";
import { loadNativeLunaPlatform } from "../../platform/native/native-platform-loader.js";
import { loadStudioAgentCatalog } from "../application/catalog/agent-catalog.js";
import { createStudioCapabilityCatalog } from "../application/catalog/capability-catalog.js";
import { loadStudioWorkflowCatalog } from "../application/catalog/workflow-catalog.js";
import {
  listStudioInputAdapters,
  previewStudioInputAdapter
} from "../application/inputs/input-adapters.js";
import {
  denyStudioAdapterPreviews,
  type StudioAdapterPreviewPort
} from "../application/inputs/adapter-preview-port.js";
import { loadStudioRoutingDefinition } from "../application/routing/router-definition-loader.js";
import { simulateStudioRouting } from "../application/routing/routing-simulator.js";
import type { StudioServerServices } from "./studio-server.js";
import { createNativeStudioAuthoringServices } from "./native-authoring-services.js";

type NativeStudioPlatform = Pick<
  LunaPlatform,
  "capabilityRegistry" | "capabilityManifests" | "inputAdapterRegistry"
>;

export type NativeStudioServicesOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly app?: AppConfig;
  readonly platform?: NativeStudioPlatform;
  readonly previews?: StudioAdapterPreviewPort;
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
  const previews = options.previews ?? denyStudioAdapterPreviews;
  const workflowsRoot = path.join(options.projectRoot, "workflows");
  const agentsRoot = path.join(options.projectRoot, "agents");
  const capabilityCatalog = createStudioCapabilityCatalog(
    platform.capabilityRegistry
  );
  const authoring = createNativeStudioAuthoringServices({
    projectRoot: options.projectRoot,
    configRoot: options.configRoot,
    platform,
    technicalCatalogFingerprint: () =>
      capabilityCatalog.technical_fingerprint
  });
  await authoring.initialize();
  const loadRouting = async () =>
    await loadStudioRoutingDefinition({
      configRoot: options.configRoot,
      ...(options.app === undefined ? {} : { app: options.app })
    });

  return {
    queries: {
      capabilities: () => capabilityCatalog,
      agents: async () =>
        await loadStudioAgentCatalog({
          agentsRoot,
          capabilityRegistry: platform.capabilityRegistry
        }),
      workflows: async () =>
        await loadStudioWorkflowCatalog({
          workflowsRoot,
          loadOptions: {
            agentsRoot,
            capabilityRegistry: platform.capabilityRegistry
          }
        })
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
      routingDefinition: loadRouting,
      simulateRouting: async (_principal, request) =>
        await simulateStudioRouting(request, await loadRouting())
    }
  };
}
