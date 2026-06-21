import type { ConfiguredWorkflowRunnerDependencies } from "../../src/core/configured-workflow/runner.js";
import {
  defaultProviderBuiltInStepRegistry,
  runBuiltInStep
} from "../../src/core/providers/built-ins.js";

export function providerAwareWorkflowDependencies(
  overrides: ConfiguredWorkflowRunnerDependencies
): ConfiguredWorkflowRunnerDependencies {
  return {
    builtInStepRegistry: defaultProviderBuiltInStepRegistry,
    runBuiltInStep,
    ...overrides
  };
}
