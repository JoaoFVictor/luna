import type { ProviderHealthProbe } from "../../core/providers/health-probe.js";
import {
  loadLunaAuth,
  type JiraLunaAuthConfig
} from "./auth.js";

type JiraProbeFetch = typeof fetch;

export function createJiraHealthProbe(options: {
  readonly loadAuth?: (projectRoot: string) => Promise<JiraLunaAuthConfig>;
  readonly fetch?: JiraProbeFetch;
} = {}): ProviderHealthProbe {
  const loadAuth = options.loadAuth ?? loadLunaAuth;
  const request = options.fetch ?? fetch;
  return {
    id: "jira",
    timeout_ms: 10_000,
    effects: ["credential_read", "network_read"],
    async run(context) {
      const auth = await loadAuth(context.projectRoot);
      const instances = Object.entries(auth.providers.jira ?? {})
        .sort(([left], [right]) => left.localeCompare(right));
      if (instances.length === 0) {
        throw new Error("Jira has no configured instances");
      }
      await Promise.all(instances.map(async ([, instance]) => {
        const response = await request(
          new URL("/rest/api/3/myself", instance.base_url),
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: `Basic ${Buffer.from(
                `${instance.email}:${instance.api_token}`
              ).toString("base64")}`
            },
            signal: context.signal
          }
        );
        if (!response.ok) {
          throw new Error(`Jira credential probe failed with status ${response.status}`);
        }
      }));
      return {
        summary: instances.length === 1
          ? "Jira respondeu para a instância configurada."
          : `Jira respondeu para ${instances.length} instâncias configuradas.`
      };
    }
  };
}

export const jiraHealthProbe = createJiraHealthProbe();
