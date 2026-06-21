import type { AgentDefinition } from "../agents/definition.js";

export type LunaToolMode = AgentDefinition["mode"];

export type LunaToolSafety = {
  localWrites: boolean;
  network: boolean;
  externalSideEffects: boolean;
};

export type LunaToolDependencies = {
  cwd: string;
};

export type LunaToolDefinition<Input, Output> = {
  id: string;
  description: string;
  parameters: unknown;
  safety: LunaToolSafety;
  modes: readonly LunaToolMode[];
  createHandler(
    dependencies: LunaToolDependencies
  ): (input: Input) => Promise<Output>;
};

export type AnyLunaToolDefinition = LunaToolDefinition<any, unknown>;
