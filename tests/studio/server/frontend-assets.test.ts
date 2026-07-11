import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StudioLocalSessionManager } from "../../../src/studio/server/security/local-session.js";
import {
  createStudioServer,
  type StudioServerServices
} from "../../../src/studio/server/studio-server.js";

const HOST = "127.0.0.1:43110";
const ORIGIN = `http://${HOST}`;

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
    routingDefinition: () => ({ type: "router", version: "2026-06", rules: [] }),
    simulateRouting: async () => ({
      status: "no_match",
      evaluations: [],
      matched_rule: null,
      target: null,
      diagnostics: []
    })
  }
};

async function frontendFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-studio-frontend-"));
  const assets = path.join(root, "assets");
  await mkdir(assets);
  await Promise.all([
    writeFile(
      path.join(root, "index.html"),
      '<!doctype html><div id="root"></div><script type="module" src="/assets/app-abc.js"></script>',
      "utf8"
    ),
    writeFile(path.join(assets, "app-abc.js"), "export const studio = true;\n", "utf8"),
    writeFile(path.join(root, "favicon.svg"), "<svg></svg>\n", "utf8"),
    writeFile(path.join(root, "icons.svg"), "<svg></svg>\n", "utf8")
  ]);
  return root;
}

function sessions(): StudioLocalSessionManager {
  return new StudioLocalSessionManager({
    allowedHosts: [HOST],
    allowedOrigins: [ORIGIN]
  });
}

describe("Studio frontend assets", () => {
  it("serves the Vite entry, hashed assets, and browser-route fallback", async () => {
    const server = await createStudioServer({
      sessions: sessions(),
      services,
      frontend: { root: await frontendFixture() },
      logger: false
    });

    const root = await server.inject({ method: "GET", url: "/", headers: { host: HOST } });
    expect(root.statusCode).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(root.headers["cache-control"]).toBe("no-store");

    const browserRoute = await server.inject({
      method: "GET",
      url: "/workflows/example",
      headers: { host: HOST }
    });
    expect(browserRoute.statusCode).toBe(200);
    expect(browserRoute.body).toContain('<div id="root"></div>');

    const asset = await server.inject({
      method: "GET",
      url: "/assets/app-abc.js",
      headers: { host: HOST }
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");
    expect(asset.body).toContain("studio = true");
    const favicon = await server.inject({
      method: "GET",
      url: "/favicon.svg",
      headers: { host: HOST }
    });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers["content-type"]).toContain("image/svg+xml");
    expect(favicon.body).toContain("<svg>");
    await server.close();
  });

  it("keeps Control API misses JSON and rejects hostile hosts for assets", async () => {
    const server = await createStudioServer({
      sessions: sessions(),
      services,
      frontend: { root: await frontendFixture() },
      logger: false
    });

    const api = await server.inject({
      method: "GET",
      url: "/api/studio/v1/not-real",
      headers: { host: HOST }
    });
    expect(api.statusCode).toBe(401);
    expect(api.headers["content-type"]).toContain("application/json");
    expect(api.body).not.toContain('<div id="root"></div>');

    const hostile = await server.inject({
      method: "GET",
      url: "/assets/app-abc.js",
      headers: { host: "attacker.invalid" }
    });
    expect(hostile.statusCode).toBe(403);
    expect(hostile.body).not.toContain("studio = true");
    await server.close();
  });

  it("fails closed with an actionable error when the build is missing", async () => {
    const dispose = vi.fn();
    const missing = await mkdtemp(path.join(tmpdir(), "luna-studio-missing-"));

    await expect(
      createStudioServer({
        sessions: sessions(),
        services: { ...services, dispose },
        frontend: { root: missing },
        logger: false
      })
    ).rejects.toMatchObject({ code: "studio_frontend_assets_invalid" });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
