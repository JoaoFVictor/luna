import type { Invocation } from "../core/router/invocation.js";

export type AdapterInput = { kind: "cli"; value: string };

export const INPUT_ADAPTER_LOAD_EFFECTS = [
  "project_read",
  "configuration_read",
  "credential_read",
  "network_read",
  "process_execution"
] as const;

export type InputAdapterLoadEffect =
  (typeof INPUT_ADAPTER_LOAD_EFFECTS)[number];

export type AdapterJsonCommandOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
};

export type AdapterContext = {
  projectRoot: string;
  configRoot: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  executeJson: (
    command: string,
    args: string[],
    options?: AdapterJsonCommandOptions
  ) => Promise<unknown>;
};

export type InputAdapter = {
  id: string;
  description: string;
  /**
   * Complete classification of operations performed by `load`. Studio treats
   * an adapter without this declaration as unavailable for browser-initiated
   * loading, while CLI callers retain the existing adapter contract.
   */
  loadEffects?: readonly InputAdapterLoadEffect[];
  /** Maximum duration exposed by browser control-plane adapters. */
  loadTimeoutMs?: number;
  load(input: AdapterInput, context: AdapterContext): Promise<Invocation>;
};

export type RegisteredInputAdapter = InputAdapter & {
  source: string;
};
