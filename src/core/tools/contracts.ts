import type { JsonSchemaLike } from "../capabilities/json-schema-types.js";

export type LunaToolMode = "read_only" | "trusted_local_write";

export type LunaToolSafety = {
  localWrites: boolean;
  network: boolean;
  externalSideEffects: boolean;
};

export type LunaToolDependencies = {
  cwd: string;
  signal?: AbortSignal;
  /** Immutable task envelope visible to this agent invocation. */
  agentInput?: unknown;
  /** Platform-bound configuration; never supplied or overridden by the model. */
  configuration?: unknown;
};

export type LocalToolContract = {
  id: string;
  description: string;
  input_schema: JsonSchemaLike;
  output_schema: JsonSchemaLike;
  safety: LunaToolSafety;
  modes: readonly LunaToolMode[];
  runtime_requirements: readonly string[];
};

export type LunaToolDefinition<Input, Output> = LocalToolContract & {
  createHandler(
    dependencies: LunaToolDependencies
  ): (input: Input) => Promise<Output>;
};

export type AnyLunaToolDefinition = LunaToolDefinition<any, unknown>;
