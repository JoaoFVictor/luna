import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadYamlFile } from "./core/config/loader.js";
import { AppConfigSchema } from "./core/config/schemas.js";
import {
  parseWorkflowTarget as parseRouterWorkflowTarget,
  routeInvocation
} from "./core/router/router.js";
import {
  RouterDefinitionSchema,
  type RouterDefinition
} from "./core/router/router-definition.js";
import {
  createLunaTargetExecutor,
  resolveRuntimeConfigRoot,
  type TargetExecutor
} from "./runtime/composition/target-executor.js";
import {
  defaultAdapterContext,
  unknownAdapterError
} from "./adapters/registry.js";
import type { AdapterContext } from "./adapters/types.js";
import {
  nativeLunaPlatform,
  type LunaPlatform
} from "./platform/native/native-platform.js";
import {
  InvocationSchema,
  type Invocation,
  type RouteTarget
} from "./core/router/invocation.js";

export type CliArgs = {
  command: "run";
  target?: RouteTarget;
  input: string;
} | {
  command: "run";
  target?: RouteTarget;
  from: string;
  value: string;
};

export type MainDependencies = {
  targetExecutor?: TargetExecutor;
  routeInvocation?: typeof routeInvocation;
  routing?: RouterDefinition;
  adapterContext?: AdapterContext;
  platform?: Pick<LunaPlatform, "inputAdapterRegistry" | "runWorkflow">;
  projectRoot?: string;
  env?: { LUNA_CONFIG_ROOT?: string };
};

class CliError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

function cliError(code: string, message: string): CliError {
  return new CliError(code, message);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(startPath = process.cwd()): Promise<string> {
  let current = path.resolve(startPath);

  while (true) {
    if (await pathExists(path.join(current, "package.json"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw cliError(
        "project_root_not_found",
        `Could not find project root from ${startPath}`
      );
    }

    current = parent;
  }
}

export function parseCliArgs(args: string[]): CliArgs {
  const [command, ...rest] = args;

  if (command === "run") {
    const allowedFlags = new Set(["--target", "--input", "--from"]);
    const unsupportedFlag = rest.find(
      (argument) => argument.startsWith("--") && !allowedFlags.has(argument)
    );
    const targetFlagIndex = rest.indexOf("--target");
    const targetValue =
      targetFlagIndex >= 0 ? rest[targetFlagIndex + 1] : undefined;
    const inputFlagIndex = rest.indexOf("--input");
    const input = inputFlagIndex >= 0 ? rest[inputFlagIndex + 1] : undefined;
    const fromFlagIndex = rest.indexOf("--from");
    const from = fromFlagIndex >= 0 ? rest[fromFlagIndex + 1] : undefined;
    const value = fromFlagIndex >= 0 ? rest[fromFlagIndex + 2] : undefined;

    if (unsupportedFlag !== undefined) {
      throw cliError("unsupported_flag", `Unsupported run flag: ${unsupportedFlag}`);
    }
    if (targetFlagIndex >= 0 && !targetValue) {
      throw cliError("invalid_target", "Missing required --target workflow:<id>");
    }

    const target =
      targetValue === undefined ? undefined : parseWorkflowTarget(targetValue);

    if (input && from) {
      throw cliError("ambiguous_input", "Use either --input or --from, not both");
    }
    if (from) {
      if (!value) {
        throw cliError("missing_from_value", "Missing required adapter input value");
      }

      return { command, target, from, value };
    }
    if (!input) {
      throw cliError("missing_input", "Missing required --input <path>");
    }

    return { command, target, input };
  }

  throw cliError("unknown_command", "Expected command: run");
}

export function parseWorkflowTarget(value: string): RouteTarget {
  try {
    return parseRouterWorkflowTarget(value);
  } catch {
    throw cliError(
      "invalid_target",
      `Invalid --target value "${value}". Expected workflow:<id>.`
    );
  }
}

export async function loadInvocationFromFile(filePath: string): Promise<Invocation> {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw cliError(
      "invocation_invalid",
      error instanceof Error ? error.message : "Unable to read invocation JSON"
    );
  }

  const result = InvocationSchema.safeParse(parsedJson);
  if (!result.success) {
    throw cliError("invocation_invalid", result.error.message);
  }

  return result.data;
}

export function resolveCliConfigRoot(
  projectRoot: string,
  env: { LUNA_CONFIG_ROOT?: string } = process.env
): string {
  return resolveRuntimeConfigRoot(projectRoot, env);
}

export async function loadRoutingDefinition(
  projectRoot: string,
  env: { LUNA_CONFIG_ROOT?: string } = process.env
): Promise<RouterDefinition> {
  const configRoot = resolveCliConfigRoot(projectRoot, env);
  const app = await loadYamlFile(
    path.join(configRoot, "app.yaml"),
    AppConfigSchema
  );

  return await loadYamlFile(
    path.join(configRoot, app.routing?.path ?? "routing.yaml"),
    RouterDefinitionSchema
  );
}

export async function main(
  args: string[],
  deps: MainDependencies = {}
): Promise<number> {
  const parsedArgs = parseCliArgs(args);
  const platform = deps.platform ?? nativeLunaPlatform;
  const registry = platform.inputAdapterRegistry;
  const projectRoot = deps.projectRoot ?? (await findProjectRoot());
  const configRoot = resolveCliConfigRoot(projectRoot, deps.env);
  let invocation: Invocation;

  if ("input" in parsedArgs) {
    invocation = await loadInvocationFromFile(parsedArgs.input);
  } else {
    const adapter = registry.get(parsedArgs.from);
    if (adapter === undefined) {
      throw unknownAdapterError(parsedArgs.from, registry);
    }

    const context =
      deps.adapterContext ?? defaultAdapterContext(projectRoot, configRoot);
    invocation = await adapter.load(
      { kind: "cli", value: parsedArgs.value },
      context
    );
  }

  if (parsedArgs.target !== undefined) {
    invocation = { ...invocation, target: parsedArgs.target };
  }

  const routing = deps.routing ?? (await loadRoutingDefinition(projectRoot, deps.env));
  const route = deps.routeInvocation ?? routeInvocation;
  const target = await route(invocation, routing);
  const targetExecutor =
    deps.targetExecutor ??
    createLunaTargetExecutor({
      projectRoot,
      configRoot,
      runWorkflow: platform.runWorkflow
    });

  return await targetExecutor.execute({ invocation, target });
}

async function runCli(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}
