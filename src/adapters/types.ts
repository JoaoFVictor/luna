import type { Invocation } from "../core/invocation/types.js";

export type AdapterInput = { kind: "cli"; value: string };

export type AdapterContext = {
  projectRoot: string;
  configRoot: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  executeJson: (command: string, args: string[]) => Promise<unknown>;
};

export type InputAdapter = {
  id: string;
  description: string;
  load(input: AdapterInput, context: AdapterContext): Promise<Invocation>;
};
