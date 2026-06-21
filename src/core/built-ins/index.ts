import { defaultBuiltInSteps } from "./catalog.js";
import { defineBuiltInRegistry } from "./registry.js";
import type { RunBuiltInStepOptions } from "./types.js";

export {
  builtInStepNames,
  defaultBuiltInSteps,
  isBuiltInStepName,
  type BuiltInStepName
} from "./catalog.js";

export const builtInStepRegistry = defineBuiltInRegistry(defaultBuiltInSteps);

export async function runBuiltInStep({
  uses,
  state,
  input,
  dependencies = {}
}: RunBuiltInStepOptions): Promise<unknown> {
  const builtIn = builtInStepRegistry.require(uses);

  return await builtIn.run({ state, input, dependencies });
}
