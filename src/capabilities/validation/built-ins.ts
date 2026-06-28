import { z } from "zod";
import {
  runValidationCommands as defaultRunValidationCommands,
  ValidationCommandSchema,
  type ValidationCommand,
  type ValidationResult
} from "./command-runner.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  resolvedInput,
  requiredInput,
  workspaceFrom
} from "../../core/built-ins/state.js";
import type { BuiltInStepDependencies, MaybePromise } from "../../core/built-ins/types.js";
import type { WorkflowState } from "../../core/workflow/state.js";
import { runValidationCommandsMetadata } from "./metadata.js";

type ValidationBuiltInDependencies = BuiltInStepDependencies & {
  runValidationCommands?: (input: {
    cwd: string;
    commands: readonly ValidationCommand[];
    maxOutputBytes: number;
  }) => MaybePromise<ValidationResult>;
};

const ValidationInputSchema = z
  .object({
    commands: z.array(ValidationCommandSchema).optional(),
    max_output_bytes: z.number().int().positive().optional(),
    cwd: z.string().min(1).optional()
  })
  .strict();

function configuredValidationFrom(state: WorkflowState): {
  readonly commands?: readonly ValidationCommand[];
  readonly max_output_bytes?: number;
} {
  const config = state.config as
    | {
        implementation?: {
          validation?: {
            commands?: readonly ValidationCommand[];
            max_output_bytes?: number;
          };
        };
      }
    | undefined;

  return config?.implementation?.validation ?? {};
}

export const runValidationCommandsBuiltIn = defineBuiltInStep<
  "validation.run_commands",
  ValidationBuiltInDependencies
>({
  name: "validation.run_commands",
  metadata: runValidationCommandsMetadata,
  async run({ state, input, dependencies = {} }) {
    const parsed = ValidationInputSchema.parse(resolvedInput(input, state));
    const configuredValidation = configuredValidationFrom(state);
    const runValidationCommands =
      dependencies.runValidationCommands ?? defaultRunValidationCommands;

    return await runValidationCommands({
      cwd: parsed.cwd ?? workspaceFrom(state).path,
      commands: parsed.commands ??
        requiredInput(configuredValidation.commands, "commands"),
      maxOutputBytes: parsed.max_output_bytes ??
        requiredInput(configuredValidation.max_output_bytes, "max_output_bytes")
    });
  }
});
