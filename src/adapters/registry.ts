import { resolveConfigRoot } from "../core/config/loader.js";
import {
  BoundedProcessError,
  runBoundedProcess
} from "../core/process/bounded-process.js";
import type {
  AdapterContext,
  AdapterJsonCommandOptions,
  InputAdapter
} from "./types.js";

const DEFAULT_JSON_COMMAND_TIMEOUT_MS = 60_000;
const MAX_JSON_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_JSON_COMMAND_STDERR_BYTES = 64 * 1024;
const MAX_JSON_COMMAND_STDIN_BYTES = 1;
const DANGEROUS_PROCESS_ENV = new Set([
  "BASH_ENV",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PS4"
]);

export type InputAdapterRegistry<Adapter extends InputAdapter = InputAdapter> = {
  get(id: string): Adapter | undefined;
  require(id: string): Adapter;
  ids(): string[];
};

export type InputAdapterRegistryError = Error & {
  code: "duplicate_input_adapter" | "unknown_input_adapter";
};

export type AdapterJsonCommandFailureReason =
  | BoundedProcessError["reason"]
  | "invalid_json";

export class AdapterJsonCommandError extends Error {
  readonly reason: AdapterJsonCommandFailureReason;

  constructor(reason: AdapterJsonCommandFailureReason, cause?: unknown) {
    super("Input adapter JSON command failed", { cause });
    this.name = "AdapterJsonCommandError";
    this.reason = reason;
  }
}

function positiveBoundedInteger(
  value: number,
  maximum: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} is outside its supported range`);
  }
  return value;
}

function adapterCommandEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !DANGEROUS_PROCESS_ENV.has(key)) {
      result[key] = value;
    }
  }
  result.PATH ??= "/usr/bin:/bin";
  result.LANG = "C.UTF-8";
  result.LC_ALL = "C.UTF-8";
  result.GIT_TERMINAL_PROMPT = "0";
  return result;
}

function registryError(
  code: InputAdapterRegistryError["code"],
  message: string
): InputAdapterRegistryError {
  const error = new Error(message) as InputAdapterRegistryError;
  error.code = code;

  return error;
}

export function unknownAdapterError(
  id: string,
  registry: Pick<InputAdapterRegistry, "ids">
): InputAdapterRegistryError {
  const available = registry.ids();
  const availableList =
    available.length === 0 ? "none" : available.map((adapterId) => `"${adapterId}"`).join(", ");

  return registryError(
    "unknown_input_adapter",
    `Unknown input adapter "${id}". Available adapters: ${availableList}.`
  );
}

export function defineInputAdapters<const Adapter extends InputAdapter>(
  adapters: readonly Adapter[]
): InputAdapterRegistry<Adapter> {
  const adapterById = new Map<string, Adapter>();
  const ids: string[] = [];

  for (const adapter of adapters) {
    if (adapterById.has(adapter.id)) {
      throw registryError(
        "duplicate_input_adapter",
        `Duplicate input adapter id: ${adapter.id}`
      );
    }

    adapterById.set(adapter.id, adapter);
    ids.push(adapter.id);
  }

  const registry: InputAdapterRegistry<Adapter> = {
    get(id) {
      return adapterById.get(id);
    },
    require(id) {
      const adapter = adapterById.get(id);
      if (adapter === undefined) {
        throw unknownAdapterError(id, registry);
      }

      return adapter;
    },
    ids() {
      return [...ids];
    }
  };

  return registry;
}

export async function executeJson(
  command: string,
  args: string[],
  options: AdapterJsonCommandOptions = {}
): Promise<unknown> {
  const timeoutMs = positiveBoundedInteger(
    options.timeoutMs ?? DEFAULT_JSON_COMMAND_TIMEOUT_MS,
    DEFAULT_JSON_COMMAND_TIMEOUT_MS,
    "Adapter command timeout"
  );
  const maxOutputBytes = positiveBoundedInteger(
    options.maxOutputBytes ?? MAX_JSON_COMMAND_OUTPUT_BYTES,
    MAX_JSON_COMMAND_OUTPUT_BYTES,
    "Adapter command output limit"
  );
  let stdout: Buffer;
  try {
    ({ stdout } = await runBoundedProcess({
      command,
      args,
      cwd: process.cwd(),
      env: adapterCommandEnvironment(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs,
      maxStdoutBytes: maxOutputBytes,
      maxStderrBytes: MAX_JSON_COMMAND_STDERR_BYTES,
      maxStdinBytes: MAX_JSON_COMMAND_STDIN_BYTES
    }));
  } catch (cause) {
    if (cause instanceof BoundedProcessError) {
      throw new AdapterJsonCommandError(cause.reason, cause);
    }
    throw cause;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(stdout)
    ) as unknown;
  } catch (cause) {
    throw new AdapterJsonCommandError("invalid_json", cause);
  }
}

export function defaultAdapterContext(
  projectRoot: string,
  configRoot = resolveConfigRoot()
): AdapterContext {
  return {
    projectRoot,
    configRoot,
    env: process.env,
    fetch,
    executeJson
  };
}
