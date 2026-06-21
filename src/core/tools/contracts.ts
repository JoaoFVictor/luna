export type LunaToolSafety = {
  writes: boolean;
};

export type LunaToolDependencies = {
  cwd: string;
};

export type LunaToolDefinition<Input, Output> = {
  id: string;
  description: string;
  parameters: unknown;
  safety: LunaToolSafety;
  modes: readonly string[];
  createHandler(
    dependencies: LunaToolDependencies
  ): (input: Input) => Promise<Output>;
};
