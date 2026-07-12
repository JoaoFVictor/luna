import type { LunaPlatform } from "../../platform/native/native-platform.js";
import {
  FileSystemStudioApplySource,
  StudioApplyPathResolver
} from "../adapters/filesystem/apply-paths.js";
import { NativeStudioResourceRevisions } from "../adapters/native/resource-revisions.js";
import { NativeStudioModelProfileCatalog } from "../adapters/native/model-profile-catalog.js";
import { StudioDraftAuthoringService } from "../application/drafts/authoring-service.js";
import type { StudioCatalogFingerprintPort } from "../application/drafts/authoring-ports.js";
import { createLocalStudioDraftAuthoringControl } from "./draft-authoring-control.js";
import type { NativeStudioAuthoringServices } from "./native-authoring-services.js";
import type { StudioDraftAuthoringControl } from "./routes/drafts.js";

export type NativeStudioDraftAuthoringSurfaceOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly platform: Pick<
    LunaPlatform,
    "capabilityRegistry" | "capabilityManifests"
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
};

export type NativeStudioDraftAuthoringSurface = {
  readonly service: StudioDraftAuthoringService;
  readonly control: StudioDraftAuthoringControl;
};

/**
 * Production integration hook. The caller still owns startup recovery and HTTP
 * registration; this factory wires only the authoring application boundary.
 */
export function createNativeStudioDraftAuthoringSurface(
  options: NativeStudioDraftAuthoringSurfaceOptions
): NativeStudioDraftAuthoringSurface {
  const source = new FileSystemStudioApplySource(
    new StudioApplyPathResolver({
      project: options.projectRoot,
      config: options.configRoot
    })
  );
  const service = new StudioDraftAuthoringService({
    drafts: options.authoring.drafts,
    source,
    revisions: new NativeStudioResourceRevisions({
      projectRoot: options.projectRoot,
      configRoot: options.configRoot,
      platform: options.platform
    }),
    catalogs: options.catalogs,
    modelProfiles: new NativeStudioModelProfileCatalog(options.configRoot),
    validation: options.authoring.validation,
    apply: options.authoring.apply
  });
  return {
    service,
    control: createLocalStudioDraftAuthoringControl(service)
  };
}
