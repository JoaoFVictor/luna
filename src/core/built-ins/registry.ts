import { builtInError } from "./errors.js";
import type { BuiltInStep, BuiltInStepMetadata } from "./types.js";

function freezeMetadata(
  metadata: BuiltInStepMetadata | undefined
): BuiltInStepMetadata | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  return Object.freeze({
    ...metadata,
    ...(metadata.locks === undefined
      ? {}
      : { locks: Object.freeze([...metadata.locks]) })
  });
}

export function defineBuiltInStep<const Name extends string>(
  step: BuiltInStep<Name>
): BuiltInStep<Name> {
  const metadata = freezeMetadata(step.metadata);

  return Object.freeze({
    ...step,
    ...(metadata === undefined ? {} : { metadata })
  });
}

export function defineBuiltInRegistry<const Steps extends readonly BuiltInStep[]>(
  steps: Steps
): {
  names: readonly Steps[number]["name"][];
  has(name: string): boolean;
  require(name: string): Steps[number];
} {
  const byName = new Map<string, Steps[number]>();

  for (const step of steps) {
    if (byName.has(step.name)) {
      throw builtInError(
        `Duplicate built-in step: ${step.name}`,
        "built_in_duplicate"
      );
    }

    byName.set(step.name, step as Steps[number]);
  }

  const names = Object.freeze(
    steps.map((step) => step.name)
  ) as readonly Steps[number]["name"][];

  return {
    names,
    has(name: string): boolean {
      return byName.has(name);
    },
    require(name: string): Steps[number] {
      const step = byName.get(name);

      if (step === undefined) {
        throw builtInError(
          `Unsupported built-in step: ${name}`,
          "built_in_unsupported"
        );
      }

      return step;
    }
  };
}
