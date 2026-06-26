import type { Invocation, RouteTarget } from "../../core/router/invocation.js";

export type TargetExecutorInput = {
  invocation: Invocation;
  target: RouteTarget;
};

export type TargetExecutor = {
  execute(input: TargetExecutorInput): Promise<number>;
};

export type FlueTargetExecutorDependencies = {
  buildCommand: (invocation: Invocation) => Promise<{
    command: string;
    args: string[];
  }>;
  execute: (command: string, args: string[]) => Promise<number>;
};

export function createFlueTargetExecutor({
  buildCommand,
  execute
}: FlueTargetExecutorDependencies): TargetExecutor {
  return {
    async execute({ invocation, target }) {
      const command = await buildCommand({
        ...invocation,
        target
      });

      return await execute(command.command, command.args);
    }
  };
}
