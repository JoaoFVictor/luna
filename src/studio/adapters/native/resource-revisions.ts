import path from "node:path";
import type { LunaPlatform } from "../../../platform/native/native-platform.js";
import type { StudioResourceRevisionPort } from "../../application/drafts/authoring-ports.js";
import { StudioCanonicalDefinitionError } from "../../application/validation/definition-validation.js";
import type { StudioValidationSnapshot } from "../../application/validation/snapshot.js";
import type { StudioResourceRef } from "../../contracts/paths.js";
import { NativeStudioDefinitionValidation } from "./definition-validation.js";

export type NativeStudioResourceRevisionsOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly platform: Pick<
    LunaPlatform,
    "capabilityRegistry" | "capabilityManifests"
  >;
  readonly definitions?: NativeStudioDefinitionValidation;
};

/** Resolves the installed canonical revision without making invalid sources uneditable. */
export class NativeStudioResourceRevisions
  implements StudioResourceRevisionPort
{
  private readonly snapshot: StudioValidationSnapshot;
  private readonly definitions: NativeStudioDefinitionValidation;

  constructor(options: NativeStudioResourceRevisionsOptions) {
    this.snapshot = {
      projectRoot: path.resolve(options.projectRoot),
      configRoot: path.resolve(options.configRoot),
      verifiedFiles: [],
      dispose: async () => undefined
    };
    this.definitions =
      options.definitions ??
      new NativeStudioDefinitionValidation({ platform: options.platform });
  }

  async current(resource: StudioResourceRef): Promise<string | null> {
    try {
      const result = await this.definitions.validate({
        snapshot: this.snapshot,
        resource,
        compile: false
      });
      return result.revision;
    } catch (cause) {
      if (cause instanceof StudioCanonicalDefinitionError) {
        return null;
      }
      throw cause;
    }
  }
}
