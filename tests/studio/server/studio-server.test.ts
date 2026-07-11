import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { StudioServerServices } from "../../../src/studio/server/studio-server.js";
import {
  createStudioServer,
  startStudioServer
} from "../../../src/studio/server/studio-server.js";
import { StudioLocalSessionManager } from "../../../src/studio/server/security/local-session.js";

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
    routingDefinition: () => ({
      type: "router",
      version: "2026-06",
      rules: [
        {
          id: "manual",
          when: { expression: "true" },
          target: "workflow:code-review"
        }
      ]
    }),
    simulateRouting: async () => ({
      status: "no_match",
      evaluations: [],
      matched_rule: null,
      target: null,
      diagnostics: [
        {
          severity: "warning",
          code: "router_no_match",
          message: "No router rule matched invocation."
        }
      ]
    })
  }
};

describe("Studio local server launcher", () => {
  it("binds to loopback and emits the capability only in the URL fragment", async () => {
    const writes: string[] = [];
    const listen = vi.fn(async (
      _server: FastifyInstance,
      _address: { readonly host: string; readonly port: number }
    ) => undefined);
    const handle = await startStudioServer({
      services,
      logger: false,
      listen,
      output: { write: (message) => writes.push(message) }
    });

    expect(listen).toHaveBeenCalledOnce();
    expect(listen.mock.calls[0]?.[0]).toBe(handle.server);
    expect(listen.mock.calls[0]?.[1]).toEqual({
      host: "127.0.0.1",
      port: 43_110
    });
    expect(handle.launchUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:43110\/#capability=[A-Za-z0-9_-]+$/
    );
    expect(handle.launchUrl).not.toContain("?capability=");
    expect(writes).toEqual([`Luna Studio: ${handle.launchUrl}\n`]);
    await handle.close();
  });

  it.each(["0.0.0.0", "192.168.1.20", "localhost", "::"])(
    "rejects non-loopback bind %s before listening",
    async (host) => {
      const listen = vi.fn();
      await expect(
        startStudioServer({ services, host, logger: false, listen })
      ).rejects.toMatchObject({
        code: "studio_server_configuration_invalid"
      });
      expect(listen).not.toHaveBeenCalled();
    }
  );

  it("preserves startup failure and closes the partially created server", async () => {
    const primary = new Error("listen failed");
    let close: ReturnType<typeof vi.spyOn> | undefined;

    await expect(
      startStudioServer({
        services,
        logger: false,
        listen: async (server) => {
          close = vi.spyOn(server, "close");
          throw primary;
        }
      })
    ).rejects.toBe(primary);
    expect(close).toHaveBeenCalledOnce();
  });

  it("enforces the configured body limit at the real Fastify boundary", async () => {
    const host = "127.0.0.1:43110";
    const origin = "http://127.0.0.1:43110";
    const sessions = new StudioLocalSessionManager({
      allowedHosts: [host],
      allowedOrigins: [origin]
    });
    const server = await createStudioServer({
      sessions,
      services,
      bodyLimitBytes: 64,
      logger: false
    });
    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/api/studio/v1/session/exchange",
      headers: { host, origin, "content-type": "application/json" },
      payload: { capability: "x".repeat(128) }
    });

    expect(response.statusCode).toBe(413);
    expect(response.body).not.toContain("x".repeat(128));
    await server.close();
  });
});
