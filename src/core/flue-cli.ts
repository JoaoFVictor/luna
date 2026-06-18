import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InvocationSchema, type Invocation } from "./types.js";

export type CliArgs = {
  command: "run";
  input: string;
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

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function parseCliArgs(args: string[]): CliArgs {
  const [command, ...rest] = args;

  if (command !== "run") {
    throw cliError("unknown_command", "Expected command: run");
  }

  const inputFlagIndex = rest.indexOf("--input");
  const input = inputFlagIndex >= 0 ? rest[inputFlagIndex + 1] : undefined;

  if (!input) {
    throw cliError("missing_input", "Missing required --input <path>");
  }

  return { command, input };
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
  const projectRoot = options.projectRoot ?? packageRoot();
  const flueCliBin = await resolveFlueCliBin(projectRoot);

  return {
    command: process.execPath,
    args: [
      flueCliBin,
      "run",
      "code-review",
      "--target",
      "node",
      "--payload",
      JSON.stringify(invocation)
    ]
  };
}

async function executeFile(command: string, args: string[]): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = execFile(command, args, (error) => {
      if (error) {
        const nodeError = error as NodeJS.ErrnoException & { code?: string | number };
        if (typeof nodeError.code === "number") {
          resolve(nodeError.code);
          return;
        }
        reject(error);
        return;
      }

      resolve(0);
    });

    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
}

export async function main(
  args: string[],
  deps: MainDependencies = {}
): Promise<number> {
  const parsedArgs = parseCliArgs(args);
  const invocation = await loadInvocationFromFile(parsedArgs.input);
  const buildCommand = deps.buildCommand ?? buildFlueRunCommand;
  const command = await buildCommand(invocation);
  const execute = deps.execute ?? executeFile;

  return await execute(command.command, command.args);
}
