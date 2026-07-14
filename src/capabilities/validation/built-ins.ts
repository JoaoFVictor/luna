import { z } from "zod";
import {
  runValidationCommands as defaultRunValidationCommands,
  ValidationCommandSchema,
  type ValidationCommand,
  type ValidationResult
} from "./command-runner.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  repositoryFrom,
  resolvedInput,
  workspaceFrom
} from "../../core/built-ins/state.js";
import type { BuiltInStepDependencies, MaybePromise } from "../../core/built-ins/types.js";
import { repositoryRequiredMetadata } from "../../core/built-ins/metadata.js";
import { runValidationCommandsMetadata } from "./metadata.js";

type ValidationBuiltInDependencies = BuiltInStepDependencies & {
  runValidationCommands?: (input: {
    cwd: string;
    commands: readonly ValidationCommand[];
    envAllowlist: readonly string[];
    maxOutputBytes: number;
  }) => MaybePromise<ValidationResult>;
};

const ValidationInputSchema = z
  .object({
    commands: z.array(ValidationCommandSchema).min(1),
    env_allowlist: z.array(z.string().min(1)),
    max_output_bytes: z.number().int().positive().max(4 * 1024 * 1024),
    cwd: z.string().min(1).optional()
  })
  .strict();

export const repositoryValidationConfigurationBuiltIn = defineBuiltInStep<
  "validation.repository_configuration"
>({
  name: "validation.repository_configuration",
  metadata: repositoryRequiredMetadata,
  run({ state }) {
    return repositoryFrom(state).validation ?? {
      commands: [],
      env_allowlist: []
    };
  }
});

export const runValidationCommandsBuiltIn = defineBuiltInStep<
  "validation.run_commands",
  ValidationBuiltInDependencies
>({
  name: "validation.run_commands",
  metadata: runValidationCommandsMetadata,
  async run({ state, input, dependencies = {} }) {
    const parsed = ValidationInputSchema.parse(resolvedInput(input, state));
    const runValidationCommands =
      dependencies.runValidationCommands ?? defaultRunValidationCommands;

    return await runValidationCommands({
      cwd: parsed.cwd ?? workspaceFrom(state).path,
      commands: parsed.commands,
      envAllowlist: parsed.env_allowlist,
      maxOutputBytes: parsed.max_output_bytes
    });
  }
});
