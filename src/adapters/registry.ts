import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveConfigRoot } from "../core/config-loader.js";
import { githubPrUrlAdapter } from "./github-pr-url/index.js";
import { jiraTaskUrlAdapter } from "./jira-task-url/index.js";
import type { AdapterContext, InputAdapter } from "./types.js";

const execFileAsync = promisify(execFile);

export type InputAdapterRegistry = {
  get(id: string): InputAdapter | undefined;
  require(id: string): InputAdapter;
  ids(): string[];
};

export type InputAdapterRegistryError = Error & {
  code: "duplicate_input_adapter" | "unknown_input_adapter";
};

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

export function defineInputAdapters(
  adapters: readonly InputAdapter[]
): InputAdapterRegistry {
  const adapterById = new Map<string, InputAdapter>();
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

  const registry: InputAdapterRegistry = {
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
  args: string[]
): Promise<unknown> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024
  });

  return JSON.parse(stdout);
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

export const inputAdapterRegistry = defineInputAdapters([
  githubPrUrlAdapter,
  jiraTaskUrlAdapter
]);
