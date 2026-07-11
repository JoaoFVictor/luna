import type { LunaPlatform } from "../../platform/native/native-platform.js";
import {
  FileSystemStudioApplySource,
  StudioApplyPathResolver
} from "../adapters/filesystem/apply-paths.js";
import { GitStudioResourceHistory } from "../adapters/git/resource-history.js";
import { NativeStudioResourceRevisions } from "../adapters/native/resource-revisions.js";
import type { StudioCatalogFingerprintPort } from "../application/drafts/authoring-ports.js";
import { StudioHistoricalDraftRestore } from "../application/history/restore-draft.js";
import { StudioResourceHistoryService } from "../application/history/service.js";
import type { NativeStudioAuthoringServices } from "./native-authoring-services.js";
import type { StudioResourceHistoryControl } from "./routes/resource-history.js";

export type NativeStudioResourceHistorySurfaceOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly platform: Pick<
    LunaPlatform,
    "capabilityRegistry" | "capabilityManifests"
  >;
  readonly authoring: Pick<NativeStudioAuthoringServices, "drafts">;
  readonly catalogs: StudioCatalogFingerprintPort;
};

export type NativeStudioResourceHistorySurface = {
  readonly service: StudioResourceHistoryService;
  readonly control: StudioResourceHistoryControl;
};

export function createNativeStudioResourceHistorySurface(
  options: NativeStudioResourceHistorySurfaceOptions
): NativeStudioResourceHistorySurface {
  const source = new FileSystemStudioApplySource(
    new StudioApplyPathResolver({
      project: options.projectRoot,
      config: options.configRoot
    })
  );
  const revisions = new NativeStudioResourceRevisions({
    projectRoot: options.projectRoot,
    configRoot: options.configRoot,
    platform: options.platform
  });
  const service = new StudioResourceHistoryService({
    history: new GitStudioResourceHistory({
      projectRoot: options.projectRoot
    }),
    restore: new StudioHistoricalDraftRestore({
      drafts: options.authoring.drafts,
      source,
      revisions,
      catalogs: options.catalogs
    })
  });
  return {
    service,
    control: {
      listResourceHistory: async (_principal, resource, query) =>
        await service.list(resource, query),
      compareResourceHistory: async (_principal, resource, request) =>
        await service.compare(resource, request),
      restoreResourceHistory: async (_principal, resource, request) =>
        await service.restore(resource, request)
    }
  };
}
