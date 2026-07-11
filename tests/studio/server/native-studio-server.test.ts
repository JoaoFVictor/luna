import { describe, expect, it, vi } from "vitest";
import type { StudioServerServices } from "../../../src/studio/server/studio-server.js";
import { startNativeStudioServer } from "../../../src/studio/server/native-studio-server.js";

const services: StudioServerServices = {
  queries: {
    capabilities: () => ({
      technical_fingerprint: `sha256:${"1".repeat(64)}`,
      presentation_fingerprint: `sha256:${"2".repeat(64)}`,
      capabilities: [],
      registrations: []
    }),
    agents: () => ({
      status: "complete",
      fingerprint: `sha256:${"3".repeat(64)}`,
      agents: [],
      diagnostics: []
    }),
    workflows: () => ({
      status: "complete",
      fingerprint: `sha256:${"4".repeat(64)}`,
      workflows: [],
      diagnostics: []
    })
  },
  inputRouting: {
    listInputAdapters: () => ({ adapters: [] }),
    previewInputAdapter: async () => {
      throw new Error("unused");
    },
    previewInputRoute: async () => {
      throw new Error("unused");
    },
    routingDefinition: () => ({
      type: "router",
      version: "2026-06",
      rules: []
    }),
    simulateRouting: async () => ({
      status: "no_match",
      evaluations: [],
      matched_rule: null,
      target: null,
      diagnostics: []
    })
  }
};

describe("native Studio server ownership", () => {
  it("releases composed services when the server launcher fails", async () => {
    const primary = new Error("server failed");
    const dispose = vi.fn();
    const createServices = vi.fn(async () => ({ ...services, dispose }));
    const startServer = vi.fn(async () => {
      throw primary;
    });

    await expect(
      startNativeStudioServer({
        projectRoot: "/project",
        configRoot: "/config",
        host: "0.0.0.0",
        allowNonLoopbackBind: true,
        publicHost: "127.0.0.1",
        publicPort: 43_110,
        createServices,
        startServer
      })
    ).rejects.toBe(primary);

    expect(createServices).toHaveBeenCalledOnce();
    expect(startServer).toHaveBeenCalledOnce();
    expect(startServer).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "0.0.0.0",
        allowNonLoopbackBind: true,
        publicHost: "127.0.0.1",
        publicPort: 43_110
      })
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});
