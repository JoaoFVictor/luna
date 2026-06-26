import path from "node:path";
import { resolveConfigRoot } from "../../core/config/loader.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { Invocation, RouteTarget } from "../../core/router/invocation.js";

export type TargetExecutorInput = {
  invocation: Invocation;
  target: RouteTarget;
};

export type TargetExecutor = {
  execute(input: TargetExecutorInput): Promise<number>;
};

export type NativeWorkflowRunInput = TargetExecutorInput & {
  readonly projectRoot: string;
  readonly configRoot: string;
};

export type NativeWorkflowRunner = (
  input: NativeWorkflowRunInput
) => Promise<unknown>;

export type LunaTargetExecutorDependencies = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly runWorkflow: NativeWorkflowRunner;
};

export function createLunaTargetExecutor({
  projectRoot,
  configRoot,
  runWorkflow
}: LunaTargetExecutorDependencies): TargetExecutor {
  return {
    async execute(input) {
      if (input.target.type !== "workflow") {
        throw runtimeError(
          "Target executor only supports workflow targets",
          "runtime_state_invalid",
          { details: { target: input.target } }
        );
      }

      await runWorkflow({ ...input, projectRoot, configRoot });
      return 0;
    }
  };
}

export function resolveRuntimeConfigRoot(
  projectRoot: string,
  env: { LUNA_CONFIG_ROOT?: string } = process.env
): string {
  const configured = resolveConfigRoot(env);
  return path.isAbsolute(configured)
    ? configured
    : path.join(projectRoot, configured);
}
