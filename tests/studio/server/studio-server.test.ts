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
    previewInputRoute: async () => {
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
  it("binds to loopback and emits the normal local URL", async () => {
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
    expect(handle.launchUrl).toBe("http://127.0.0.1:43110/");
    expect(writes).toEqual([`Luna Studio: ${handle.launchUrl}\n`]);
    await handle.close();
  });

  it.each(["0.0.0.0", "192.168.1.20", "localhost", "::"])(
    "rejects non-loopback bind %s and releases owned services",
    async (host) => {
      const listen = vi.fn();
      const dispose = vi.fn();
      await expect(
        startStudioServer({
          services: { ...services, dispose },
          host,
          logger: false,
          listen
        })
      ).rejects.toMatchObject({
        code: "studio_server_configuration_invalid"
      });
      expect(listen).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    }
  );

  it("supports an explicit wildcard container bind with loopback public authority", async () => {
    const listen = vi.fn(async (
      _server: FastifyInstance,
      _address: { readonly host: string; readonly port: number }
    ) => undefined);
    const handle = await startStudioServer({
      services,
      host: "0.0.0.0",
      port: 43_110,
      allowNonLoopbackBind: true,
      publicHost: "127.0.0.1",
      publicPort: 43_112,
      logger: false,
      listen
    });

    expect(listen.mock.calls[0]?.[1]).toEqual({
      host: "0.0.0.0",
      port: 43_110
    });
    expect(handle.launchUrl).toBe("http://127.0.0.1:43112/");

    const allowed = await handle.server.inject({
      method: "GET",
      url: "/health",
      headers: { host: "127.0.0.1:43112" }
    });
    const bindAuthority = await handle.server.inject({
      method: "GET",
      url: "/health",
      headers: { host: "0.0.0.0:43110" }
    });
    expect(allowed.statusCode).toBe(200);
    expect(bindAuthority.statusCode).toBe(403);
    await handle.close();
  });

  it("requires an explicit loopback public authority for wildcard binds", async () => {
    await expect(
      startStudioServer({
        services,
        host: "0.0.0.0",
        allowNonLoopbackBind: true,
        logger: false,
        listen: async () => undefined
      })
    ).rejects.toMatchObject({
      code: "studio_server_configuration_invalid"
    });
  });

  it.each(["192.168.1.20", "localhost"])(
    "does not turn container opt-in into an arbitrary network bind for %s",
    async (host) => {
      await expect(
        startStudioServer({
          services,
          host,
          allowNonLoopbackBind: true,
          publicHost: "127.0.0.1",
          logger: false,
          listen: async () => undefined
        })
      ).rejects.toMatchObject({
        code: "studio_server_configuration_invalid"
      });
    }
  );

  it("rejects a non-loopback public authority in container mode", async () => {
    await expect(
      startStudioServer({
        services,
        host: "0.0.0.0",
        allowNonLoopbackBind: true,
        publicHost: "192.168.1.20",
        logger: false,
        listen: async () => undefined
      })
    ).rejects.toMatchObject({
      code: "studio_server_configuration_invalid"
    });
  });

  it.each([0, 65_536, 1.5])(
    "rejects invalid public port %s",
    async (publicPort) => {
      await expect(
        startStudioServer({
          services,
          publicPort,
          logger: false,
          listen: async () => undefined
        })
      ).rejects.toMatchObject({
        code: "studio_server_configuration_invalid"
      });
    }
  );

  it("canonicalizes the default HTTP public port for browser Host and Origin", async () => {
    const handle = await startStudioServer({
      services,
      port: 43_110,
      publicPort: 80,
      logger: false,
      listen: async () => undefined
    });

    expect(handle.launchUrl).toBe("http://127.0.0.1/");
    const response = await handle.server.inject({
      method: "GET",
      url: "/health",
      headers: { host: "127.0.0.1" }
    });
    expect(response.statusCode).toBe(200);
    await handle.close();
  });

  it.each([0, 65_536, 1.5])(
    "rejects invalid port %s and releases owned services",
    async (port) => {
      const dispose = vi.fn();
      await expect(
        startStudioServer({
          services: { ...services, dispose },
          port,
          logger: false
        })
      ).rejects.toMatchObject({
        code: "studio_server_configuration_invalid"
      });
      expect(dispose).toHaveBeenCalledOnce();
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

  it("falls back to direct disposal when closing a failed startup also fails", async () => {
    const primary = new Error("listen failed");
    const dispose = vi.fn();
    let close: ReturnType<typeof vi.spyOn> | undefined;

    await expect(
      startStudioServer({
        services: { ...services, dispose },
        logger: false,
        listen: async (server) => {
          close = vi
            .spyOn(server, "close")
            .mockRejectedValueOnce(new Error("close failed"));
          throw primary;
        }
      })
    ).rejects.toBe(primary);
    expect(close).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes composed service resources on normal and failed startup", async () => {
    const normalDispose = vi.fn();
    const normal = await startStudioServer({
      services: { ...services, dispose: normalDispose },
      logger: false,
      listen: async () => undefined
    });
    await normal.close();
    expect(normalDispose).toHaveBeenCalledOnce();

    const failedDispose = vi.fn();
    await expect(
      startStudioServer({
        services: { ...services, dispose: failedDispose },
        logger: false,
        listen: async () => {
          throw new Error("listen failed");
        }
      })
    ).rejects.toThrow("listen failed");
    expect(failedDispose).toHaveBeenCalledOnce();
  });

  it("closes and disposes when Control API registration fails", async () => {
    const primary = new Error("route registration failed");
    const dispose = vi.fn();
    const sessions = new StudioLocalSessionManager({
      allowedHosts: ["127.0.0.1:43110"],
      allowedOrigins: ["http://127.0.0.1:43110"]
    });

    await expect(
      createStudioServer({
        sessions,
        services: { ...services, dispose },
        logger: false,
        registerControlApi: async () => {
          throw primary;
        }
      })
    ).rejects.toBe(primary);
    expect(dispose).toHaveBeenCalledOnce();
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

  it("routes historical run ids longer than Fastify's default limit", async () => {
    const longRunId = `historical-${"a".repeat(150)}`;
    const sessions = new StudioLocalSessionManager({
      allowedHosts: ["127.0.0.1:43110"],
      allowedOrigins: ["http://127.0.0.1:43110"]
    });
    const server = await createStudioServer({
      sessions,
      services,
      logger: false,
      registerControlApi: async (instance) => {
        instance.get("/runs/:runId", async (request) => ({
          run_id: (request.params as { runId: string }).runId
        }));
      }
    });

    const response = await server.inject({
      method: "GET",
      url: `/runs/${longRunId}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ run_id: longRunId });
    await server.close();
  });
});
