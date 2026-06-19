import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import {
  defaultAdapterContext,
  inputAdapterRegistry,
  unknownAdapterError,
  type InputAdapterRegistry
} from "../adapters/registry.js";
import type { AdapterContext } from "../adapters/types.js";
import {
  InvocationSchema,
  RouteTargetSchema,
  type Invocation,
  type RouteTarget
} from "./types.js";

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

export type FlueRunCommand = {
  command: string;
  args: string[];
};

export type BuildFlueRunCommandOptions = {
  projectRoot?: string;
};

export type MainDependencies = {
  execute?: (command: string, args: string[]) => Promise<number>;
  buildCommand?: (invocation: Invocation) => Promise<FlueRunCommand>;
  adapterRegistry?: InputAdapterRegistry;
  adapterContext?: AdapterContext;
};

type PackageJsonWithBin = {
  bin?: {
    flue?: unknown;
  };
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
    const hasPackageJson = await pathExists(path.join(current, "package.json"));
    const hasFlueCliPackage = await pathExists(
      path.join(current, "node_modules", "@flue", "cli", "package.json")
    );

    if (hasPackageJson && hasFlueCliPackage) {
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
    const workflowFlagIndex = rest.indexOf("--workflow");
    const workflow =
      workflowFlagIndex >= 0 ? rest[workflowFlagIndex + 1] : undefined;
    const targetFlagIndex = rest.indexOf("--target");
    const targetValue =
      targetFlagIndex >= 0 ? rest[targetFlagIndex + 1] : undefined;
    const inputFlagIndex = rest.indexOf("--input");
    const input = inputFlagIndex >= 0 ? rest[inputFlagIndex + 1] : undefined;
    const fromFlagIndex = rest.indexOf("--from");
    const from = fromFlagIndex >= 0 ? rest[fromFlagIndex + 1] : undefined;
    const value = fromFlagIndex >= 0 ? rest[fromFlagIndex + 2] : undefined;

    if (workflowFlagIndex >= 0 && targetFlagIndex >= 0) {
      throw cliError(
        "ambiguous_target",
        "Use either --workflow or --target, not both"
      );
    }

    if (workflowFlagIndex >= 0 && !workflow) {
      throw cliError("missing_workflow", "Missing required --workflow <id>");
    }

    if (targetFlagIndex >= 0 && !targetValue) {
      throw cliError("invalid_target", "Missing required --target workflow:<id>");
    }

    const target =
      workflow !== undefined
        ? RouteTargetSchema.parse({ type: "workflow", id: workflow })
        : targetValue === undefined
          ? undefined
          : parseWorkflowTarget(targetValue);

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
  const prefix = "workflow:";
  const candidate: unknown = value.startsWith(prefix)
    ? { type: "workflow", id: value.slice(prefix.length) }
    : value;
  const result = RouteTargetSchema.safeParse(candidate);

  if (!result.success) {
    throw cliError(
      "invalid_target",
      `Invalid --target value "${value}". Expected workflow:<id>.`
    );
  }

  return result.data;
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

export async function resolveFlueCliBin(projectRoot: string): Promise<string> {
  const packageJsonPath = path.join(
    projectRoot,
    "node_modules",
    "@flue",
    "cli",
    "package.json"
  );

  let packageJson: PackageJsonWithBin;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJsonWithBin;
  } catch (error) {
    throw cliError(
      "flue_cli_missing",
      error instanceof Error ? error.message : "Unable to read @flue/cli package.json"
    );
  }

  if (typeof packageJson.bin?.flue !== "string" || packageJson.bin.flue.length === 0) {
    throw cliError("flue_cli_missing", "@flue/cli package.json does not define bin.flue");
  }

  return path.resolve(path.dirname(packageJsonPath), packageJson.bin.flue);
}

export async function buildFlueRunCommand(
  invocation: Invocation,
  options: BuildFlueRunCommandOptions = {}
): Promise<FlueRunCommand> {
  const projectRoot = options.projectRoot ?? (await findProjectRoot());
  const flueCliBin = await resolveFlueCliBin(projectRoot);

  return {
    command: process.execPath,
    args: [
      flueCliBin,
      "run",
      "luna",
      "--target",
      "node",
      "--payload",
      JSON.stringify(invocation)
    ]
  };
}

async function executeFile(command: string, args: string[]): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      resolve(childProcessExitCode(code, signal));
    });
  });
}

export function childProcessFailureExitCode(error: unknown): number | undefined {
  const nodeError = error as {
    code?: string | number | null;
    signal?: string | null;
  };

  if (typeof nodeError.code === "number") {
    return nodeError.code;
  }

  if (typeof nodeError.signal === "string") {
    return 128 + signalNumber(nodeError.signal);
  }

  return undefined;
}

export function childProcessExitCode(
  code: number | null,
  signal: NodeJS.Signals | null
): number {
  if (typeof code === "number") {
    return code;
  }

  if (signal !== null) {
    return 128 + signalNumber(signal);
  }

  return 1;
}

function signalNumber(signal: string): number {
  const signalValue = osConstants.signals[
    signal as keyof typeof osConstants.signals
  ];

  return signalValue ?? 1;
}

export async function main(
  args: string[],
  deps: MainDependencies = {}
): Promise<number> {
  const parsedArgs = parseCliArgs(args);
  const registry = deps.adapterRegistry ?? inputAdapterRegistry;
  let invocation: Invocation;

  if ("input" in parsedArgs) {
    invocation = await loadInvocationFromFile(parsedArgs.input);
  } else {
    const adapter = registry.get(parsedArgs.from);
    if (adapter === undefined) {
      throw unknownAdapterError(parsedArgs.from, registry);
    }

    const context =
      deps.adapterContext ?? defaultAdapterContext(await findProjectRoot());
    invocation = await adapter.load(
      { kind: "cli", value: parsedArgs.value },
      context
    );
  }

  if (parsedArgs.target !== undefined) {
    invocation = {
      ...invocation,
      target: parsedArgs.target
    };
  }

  const buildCommand = deps.buildCommand ?? buildFlueRunCommand;
  const command = await buildCommand(invocation);
  const execute = deps.execute ?? executeFile;

  return await execute(command.command, command.args);
}
