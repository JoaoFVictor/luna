import type { ProviderHealthProbe } from "../../core/providers/health-probe.js";
import { runGh, type RunGh } from "./gh.js";

export function createGitHubHealthProbe(options: {
  readonly run?: RunGh;
} = {}): ProviderHealthProbe {
  const run = options.run ?? runGh;
  return {
    id: "github",
    timeout_ms: 10_000,
    effects: ["credential_read", "network_read", "process_execution"],
    async run(context) {
      const output = await run(
        context.projectRoot,
        ["api", "user", "--jq", ".login"],
        { timeoutMs: 10_000, signal: context.signal }
      );
      if (output.trim() === "") {
        throw new Error("GitHub credential probe returned no authenticated account");
      }
      return { summary: "GitHub respondeu com uma conta autenticada." };
    }
  };
}

export const githubHealthProbe = createGitHubHealthProbe();
