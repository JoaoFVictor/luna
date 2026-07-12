import type { ProviderHealthProbeRegistry } from "../../../core/providers/health-probe-registry.js";
import {
  StudioProviderProbeResultSchema,
  type StudioProviderProbeResult
} from "../../contracts/configuration.js";
import type { StudioProviderHealthTracker } from "./provider-health.js";

export class StudioProviderHealthProbeService {
  readonly #projectRoot: string;
  readonly #configRoot: string;
  readonly #registry: ProviderHealthProbeRegistry;
  readonly #tracker: StudioProviderHealthTracker;
  readonly #now: () => Date;

  constructor(options: {
    readonly projectRoot: string;
    readonly configRoot: string;
    readonly registry: ProviderHealthProbeRegistry;
    readonly tracker: StudioProviderHealthTracker;
    readonly now?: () => Date;
  }) {
    this.#projectRoot = options.projectRoot;
    this.#configRoot = options.configRoot;
    this.#registry = options.registry;
    this.#tracker = options.tracker;
    this.#now = options.now ?? (() => new Date());
  }

  async run(providerId: string, signal?: AbortSignal): Promise<StudioProviderProbeResult> {
    const probe = this.#registry.get(providerId);
    if (probe === undefined) {
      return {
        provider_id: providerId,
        status: "unsupported",
        summary: "Este provider não possui um teste de conexão dedicado."
      };
    }
    const timeout = AbortSignal.timeout(probe.timeout_ms);
    const combined = signal === undefined
      ? timeout
      : AbortSignal.any([signal, timeout]);
    try {
      const result = await probe.run({
        projectRoot: this.#projectRoot,
        configRoot: this.#configRoot,
        signal: combined
      });
      const checkedAt = this.#now().toISOString();
      const response = StudioProviderProbeResultSchema.parse({
        provider_id: providerId,
        probe_id: probe.id,
        status: "healthy",
        checked_at: checkedAt,
        effects: [...probe.effects],
        timeout_ms: probe.timeout_ms,
        summary: result.summary
      });
      this.#tracker.markHealthy(providerId, probe.id, checkedAt);
      return response;
    } catch {
      this.#tracker.clear(providerId);
      return {
        provider_id: providerId,
        probe_id: probe.id,
        status: "unhealthy",
        effects: [...probe.effects],
        timeout_ms: probe.timeout_ms,
        summary: timeout.aborted
          ? "O teste de conexão excedeu o tempo limite."
          : "O provider recusou o teste ou as credenciais não estão válidas."
      };
    }
  }
}
