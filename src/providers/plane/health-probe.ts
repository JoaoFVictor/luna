import type { ProviderHealthProbe } from "../../core/providers/health-probe.js";
import {
  loadPlaneAuth,
  type PlaneLunaAuthConfig
} from "./auth.js";

type PlaneProbeFetch = typeof fetch;

export function createPlaneHealthProbe(options: {
  readonly loadAuth?: (projectRoot: string) => Promise<PlaneLunaAuthConfig>;
  readonly fetch?: PlaneProbeFetch;
} = {}): ProviderHealthProbe {
  const loadAuth = options.loadAuth ?? loadPlaneAuth;
  const request = options.fetch ?? fetch;
  return {
    id: "plane",
    timeout_ms: 10_000,
    effects: ["credential_read", "network_read"],
    async run(context) {
      const auth = await loadAuth(context.projectRoot);
      const instances = Object.entries(auth.providers.plane ?? {})
        .sort(([left], [right]) => left.localeCompare(right));
      if (instances.length === 0) {
        throw new Error("Plane has no configured instances");
      }

      await Promise.all(instances.map(async ([, instance]) => {
        const response = await request(currentUserUrl(instance.base_url), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-API-Key": instance.api_key
          },
          signal: context.signal
        });
        if (!response.ok) {
          throw new Error(`Plane credential probe failed with status ${response.status}`);
        }
      }));

      return {
        summary: instances.length === 1
          ? "Plane respondeu para a instância configurada."
          : `Plane respondeu para ${instances.length} instâncias configuradas.`
      };
    }
  };
}

function currentUserUrl(configuredBaseUrl: string): URL {
  const baseUrl = new URL(configuredBaseUrl);
  if (baseUrl.hostname === "app.plane.so") {
    baseUrl.hostname = "api.plane.so";
  }
  return new URL("/api/v1/users/me/", baseUrl);
}

export const planeHealthProbe = createPlaneHealthProbe();
