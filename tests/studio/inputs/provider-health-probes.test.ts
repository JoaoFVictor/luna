import { describe, expect, it } from "vitest";
import { defineProviderHealthProbes } from "../../../src/core/providers/health-probe-registry.js";
import { StudioProviderHealthTracker } from "../../../src/studio/application/inputs/provider-health.js";
import { StudioProviderHealthProbeService } from "../../../src/studio/application/inputs/provider-health-probes.js";
import { defineInputAdapters } from "../../../src/adapters/registry.js";
import { createStudioConfigurationPosture } from "../../../src/studio/application/configuration/posture.js";

describe("Studio provider health probes", () => {
  it("records only successful probe evidence and returns redacted failures", async () => {
    const tracker = new StudioProviderHealthTracker();
    const registry = defineProviderHealthProbes([{
      id: "healthy",
      timeout_ms: 1_000,
      effects: ["network_read"],
      run: async () => ({ summary: "Provider respondeu." })
    }, {
      id: "broken",
      timeout_ms: 1_000,
      effects: ["credential_read", "network_read"],
      run: async () => {
        throw new Error("credential-canary https://private.example")
      }
    }]);
    const service = new StudioProviderHealthProbeService({
      projectRoot: "/project",
      configRoot: "/config",
      registry,
      tracker,
      now: () => new Date("2026-07-12T10:00:00.000Z")
    });

    await expect(service.run("healthy")).resolves.toMatchObject({
      status: "healthy",
      checked_at: "2026-07-12T10:00:00.000Z"
    });
    expect(tracker.get("healthy")).toEqual({
      probeId: "healthy",
      checkedAt: "2026-07-12T10:00:00.000Z"
    });

    const failure = await service.run("broken");
    expect(failure).toMatchObject({ status: "unhealthy" });
    expect(JSON.stringify(failure)).not.toContain("credential-canary");
    expect(JSON.stringify(failure)).not.toContain("private.example");
    expect(tracker.get("broken")).toBeUndefined();
    await expect(service.run("unsupported")).resolves.toMatchObject({
      status: "unsupported"
    });
  });

  it("clears an earlier healthy observation when the latest probe fails", async () => {
    let fail = false;
    const tracker = new StudioProviderHealthTracker();
    const registry = defineProviderHealthProbes([{
      id: "flaky",
      timeout_ms: 1_000,
      effects: ["network_read"],
      run: async () => {
        if (fail) throw new Error("offline");
        return { summary: "ok" };
      }
    }]);
    const service = new StudioProviderHealthProbeService({
      projectRoot: "/project",
      configRoot: "/config",
      registry,
      tracker
    });
    await service.run("flaky");
    expect(tracker.get("flaky")).toBeDefined();
    fail = true;
    await service.run("flaky");

    const posture = createStudioConfigurationPosture({
      projectRoot: "/project",
      configRoot: "/config",
      inputAdapters: defineInputAdapters([{
        id: "flaky-input",
        source: "flaky",
        description: "Flaky",
        load: async () => ({ version: "2026-06", source: "flaky", event: "test" })
      }]),
      providerHealth: tracker,
      providerHealthProbes: registry,
      agents: async () => ({
        status: "complete",
        fingerprint: `sha256:${"a".repeat(64)}`,
        agents: [],
        diagnostics: []
      }),
      workflows: async () => ({
        status: "complete",
        fingerprint: `sha256:${"b".repeat(64)}`,
        workflows: [],
        diagnostics: []
      })
    });
    await expect(posture.providers()).resolves.toMatchObject({
      providers: [{ id: "flaky", credential_status: "not_checked" }]
    });
  });

  it("reports an enforced probe timeout without recording health", async () => {
    const tracker = new StudioProviderHealthTracker();
    const registry = defineProviderHealthProbes([{
      id: "slow",
      timeout_ms: 5,
      effects: ["network_read"],
      run: async ({ signal }) => await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("timed out")), {
          once: true
        });
      })
    }]);
    const service = new StudioProviderHealthProbeService({
      projectRoot: "/project",
      configRoot: "/config",
      registry,
      tracker
    });

    await expect(service.run("slow")).resolves.toMatchObject({
      status: "unhealthy",
      summary: "O teste de conexão excedeu o tempo limite."
    });
    expect(tracker.get("slow")).toBeUndefined();
  });
});
