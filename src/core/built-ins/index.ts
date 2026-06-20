import { defaultBuiltInSteps } from "./catalog.js";
import { defineBuiltInRegistry } from "./registry.js";
import type { RunBuiltInStepOptions } from "./types.js";

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

export * from "./catalog.js";
export * from "./code-review.js";
export * from "./errors.js";
export * from "./implementation.js";
export * from "./registry.js";
export * from "./types.js";
