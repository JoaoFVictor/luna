import type { ProviderHealthProbe } from "./health-probe.js";

export type ProviderHealthProbeRegistry = {
  readonly ids: () => readonly string[];
  readonly get: (providerId: string) => ProviderHealthProbe | undefined;
  readonly require: (providerId: string) => ProviderHealthProbe;
};

export function defineProviderHealthProbes(
  probes: readonly ProviderHealthProbe[]
): ProviderHealthProbeRegistry {
  const byId = new Map<string, ProviderHealthProbe>();
  for (const probe of probes) {
    if (
      probe.id.trim() === "" ||
      !Number.isSafeInteger(probe.timeout_ms) ||
      probe.timeout_ms < 1 ||
      probe.effects.length === 0 ||
      new Set(probe.effects).size !== probe.effects.length
    ) {
      throw new Error("Provider health probe registration is invalid");
    }
    if (byId.has(probe.id)) {
      throw new Error(`Duplicate provider health probe: ${probe.id}`);
    }
    byId.set(probe.id, Object.freeze({ ...probe, effects: Object.freeze([...probe.effects]) }));
  }
  return Object.freeze({
    ids: () => [...byId.keys()].sort(),
    get: (providerId) => byId.get(providerId),
    require(providerId) {
      const probe = byId.get(providerId);
      if (probe === undefined) throw new Error(`Provider health probe is not registered: ${providerId}`);
      return probe;
    }
  });
}
