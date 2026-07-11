import path from "node:path";
import type {
  StudioApplyVerificationContext,
  StudioInstalledApplyVerificationPort
} from "../../application/apply/ports.js";
import { StudioApplyError } from "../../application/apply/errors.js";
import type { StudioValidationSnapshot } from "../../application/validation/snapshot.js";
import {
  NativeStudioDefinitionValidation,
  type NativeStudioDefinitionValidationOptions
} from "./definition-validation.js";
import { studioResourceKey } from "../../contracts/paths.js";

export type NativeStudioInstalledApplyVerifierOptions =
  NativeStudioDefinitionValidationOptions & {
    readonly projectRoot: string;
    readonly configRoot: string;
    readonly definitions?: NativeStudioDefinitionValidation;
  };

/** Reloads installed files through the same native loaders/compiler as validation. */
export class NativeStudioInstalledApplyVerifier
  implements StudioInstalledApplyVerificationPort
{
  private readonly projectRoot: string;
  private readonly configRoot: string;
  private readonly definitions: NativeStudioDefinitionValidation;

  constructor(options: NativeStudioInstalledApplyVerifierOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.configRoot = path.resolve(options.configRoot);
    this.definitions =
      options.definitions ??
      new NativeStudioDefinitionValidation({ platform: options.platform });
  }

  async verify(
    context: StudioApplyVerificationContext
  ): Promise<Readonly<Record<string, string>>> {
    const snapshot: StudioValidationSnapshot = {
      projectRoot: this.projectRoot,
      configRoot: this.configRoot,
      verifiedFiles: [],
      dispose: async () => undefined
    };
    const revisions: Record<string, string> = {};
    try {
      for (const resource of context.resources) {
        const validated = await this.definitions.validate({
          snapshot,
          resource,
          compile: true
        });
        revisions[studioResourceKey(resource)] = validated.revision;
      }
    } catch (cause) {
      throw new StudioApplyError(
        "studio_apply_validation_failed",
        "Installed Studio resources failed canonical validation",
        { cause }
      );
    }
    return revisions;
  }
}

