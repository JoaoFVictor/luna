import type { JsonSchemaLike } from "../capabilities/json-schema-types.js";

export type LunaToolMode = "read_only" | "trusted_local_write";

export type LunaToolSafety = {
  localWrites: boolean;
  network: boolean;
  externalSideEffects: boolean;
};

export type LunaToolDependencies = {
  cwd: string;
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
