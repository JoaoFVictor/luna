import {
  defaultBuiltInCatalog,
  defaultBuiltInSteps,
  builtInStepMetadataRegistry
} from "./catalog.js";
import type { RunBuiltInStepOptions } from "./types.js";

export const builtInStepRegistry = builtInStepMetadataRegistry;

export async function runBuiltInStep(
  options: RunBuiltInStepOptions
): Promise<unknown> {
  return await defaultBuiltInCatalog.runBuiltInStep(options);
}

export { defaultBuiltInSteps };
