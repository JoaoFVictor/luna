import path from "node:path";
import type { AppConfig } from "../../core/config/schemas.js";
import type { LunaPlatform } from "../../platform/native/native-platform.js";
import {
  FileSystemStudioApplySource,
  StudioApplyPathResolver
} from "../adapters/filesystem/apply-paths.js";
import { NativeStudioResourceRevisions } from "../adapters/native/resource-revisions.js";
import { loadStudioAgentCatalog } from "../application/catalog/agent-catalog.js";
import { loadStudioWorkflowCatalog } from "../application/catalog/workflow-catalog.js";
import { createStudioConfigurationPosture } from "../application/configuration/posture.js";
import { StudioConfigurationService } from "../application/configuration/service.js";
import type { StudioCatalogFingerprintPort } from "../application/drafts/authoring-ports.js";
import { createLocalStudioConfigurationControl } from "./configuration-control.js";
import type { NativeStudioAuthoringServices } from "./native-authoring-services.js";
import type { StudioConfigurationControl } from "./routes/configuration.js";
import type { StudioProviderHealthTracker } from "../application/inputs/provider-health.js";

export type NativeStudioConfigurationSurfaceOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly app?: AppConfig;
  readonly platform: Pick<
    LunaPlatform,
    | "capabilityRegistry"
    | "capabilityManifests"
    | "inputAdapterRegistry"
  >;
  readonly authoring: Pick<
    NativeStudioAuthoringServices,
    "drafts" | "validation"
  > & {
    readonly apply: Pick<
      NativeStudioAuthoringServices["apply"],
      "plan" | "apply"
    >;
  };
  readonly catalogs: StudioCatalogFingerprintPort;
  readonly providerHealth?: Pick<StudioProviderHealthTracker, "get">;
};

export type NativeStudioConfigurationSurface = {
  readonly service: StudioConfigurationService;
  readonly control: StudioConfigurationControl;
};

export function createNativeStudioConfigurationSurface(
  options: NativeStudioConfigurationSurfaceOptions
): NativeStudioConfigurationSurface {
  const source = new FileSystemStudioApplySource(
    new StudioApplyPathResolver({
      project: options.projectRoot,
      config: options.configRoot
    })
  );
  const service = new StudioConfigurationService({
    drafts: options.authoring.drafts,
    source,
    revisions: new NativeStudioResourceRevisions({
      projectRoot: options.projectRoot,
      configRoot: options.configRoot,
      platform: options.platform
    }),
    catalogs: options.catalogs,
    validation: options.authoring.validation,
    apply: options.authoring.apply
  });
  const agentsRoot = path.join(options.projectRoot, "agents");
  const workflowsRoot = path.join(options.projectRoot, "workflows");
  const posture = createStudioConfigurationPosture({
    projectRoot: options.projectRoot,
    configRoot: options.configRoot,
    ...(options.app === undefined ? {} : { app: options.app }),
    inputAdapters: options.platform.inputAdapterRegistry,
    ...(options.providerHealth === undefined ? {} : { providerHealth: options.providerHealth }),
    agents: async () =>
      await loadStudioAgentCatalog({
        agentsRoot,
        capabilityRegistry: options.platform.capabilityRegistry
      }),
    workflows: async () =>
      await loadStudioWorkflowCatalog({
        workflowsRoot,
        loadOptions: {
          agentsRoot,
          capabilityRegistry: options.platform.capabilityRegistry
        }
      })
  });
  return {
    service,
    control: createLocalStudioConfigurationControl(service, posture)
  };
}
