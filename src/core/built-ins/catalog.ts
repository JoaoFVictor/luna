import { defineBuiltInRegistry } from "./registry.js";
import type {
  BuiltInStep,
  RunBuiltInStepOptions
} from "./types.js";

export function createBuiltInStepCatalog<
  const Steps extends readonly BuiltInStep[]
>(steps: Steps): {
  steps: Steps;
  names: readonly Steps[number]["name"][];
  registry: ReturnType<typeof defineBuiltInRegistry<Steps>>;
  isBuiltInStepName(value: string): value is Steps[number]["name"];
  runBuiltInStep(options: RunBuiltInStepOptions): Promise<unknown>;
} {
  const registry = defineBuiltInRegistry(steps);
  const nameSet: ReadonlySet<string> = new Set(registry.names);

  return Object.freeze({
    steps,
    names: registry.names,
    registry,
    isBuiltInStepName(value: string): value is Steps[number]["name"] {
      return nameSet.has(value);
    },
    async runBuiltInStep({
      uses,
      state,
      input,
      dependencies = {},
      observability
    }: RunBuiltInStepOptions): Promise<unknown> {
      const builtIn = registry.require(uses);

      return await builtIn.run({
        state,
        input,
        dependencies,
        observability
      });
    }
  });
}
