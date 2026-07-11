import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { RouterDefinition } from "../../../src/core/router/router-definition.js";
import {
  registerStudioControlApi,
  type StudioControlApiQueries
} from "../../../src/studio/server/control-api.js";
import type { StudioInputRoutingControl } from "../../../src/studio/server/routes/input-routing.js";
import { StudioAdapterPreviewError } from "../../../src/studio/application/inputs/input-adapters.js";
import { StudioLocalSessionManager } from "../../../src/studio/server/security/local-session.js";

const host = "127.0.0.1:43110";
const origin = "http://127.0.0.1:43110";

const defaultQueries: StudioControlApiQueries = {
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
};

const routingDefinition: RouterDefinition = {
  type: "router",
  version: "2026-06",
  rules: [
    {
      id: "manual",
      when: { expression: "true" },
      target: "workflow:code-review"
    }
  ]
};

const defaultInputRouting: StudioInputRoutingControl = {
  listInputAdapters: () => ({
    adapters: [
      {
        id: "github-pr-url",
        description: "GitHub pull request URL",
        source: "github",
        input_contract: { kind: "cli", value_type: "string" },
        preview: { enabled: true, effects: [], timeout_ms: 1_000 }
      }
    ]
  }),
  previewInputAdapter: async (_principal, request) => ({
    adapter_id: request.adapter_id,
    effects: [],
    invocation: {
      version: "2026-06",
      source: "github",
      event: "pull_request"
    },
    redacted_fields: ["payload"]
  }),
  routingDefinition: () => routingDefinition,
  simulateRouting: async () => ({
    status: "matched",
    evaluations: [
      {
        rule_id: "manual",
        rule_index: 0,
        expression_path: "$.rules[0].when.expression",
        outcome: "boolean",
        result: true
      }
    ],
    matched_rule: { rule_id: "manual", rule_index: 0 },
    target: { type: "workflow", id: "code-review" },
    diagnostics: []
  })
};

async function fixture(
  options: {
    readonly bodyLimit?: number;
    readonly queries?: StudioControlApiQueries;
    readonly inputRouting?: StudioInputRoutingControl;
  } = {}
) {
  const sessions = new StudioLocalSessionManager({
    allowedHosts: [host],
    allowedOrigins: [origin]
  });
  const server = Fastify({
    logger: false,
    bodyLimit: options.bodyLimit ?? 64 * 1024
  });
  await registerStudioControlApi(server, {
    sessions,
    queries: options.queries ?? defaultQueries,
    inputRouting: options.inputRouting ?? defaultInputRouting
  });
  server.get("/assets/app.js", async (_request, reply) => {
    reply.type("application/javascript");
    return "export const studio = true;";
  });
  server.post("/api/studio/v1/test-mutation", async () => ({ ok: true }));
  await server.ready();
  return { server, sessions };
}

async function localSession(
  server: Awaited<ReturnType<typeof fixture>>["server"],
  capability: string
) {
  const response = await server.inject({
    method: "POST",
    url: "/api/studio/v1/session/exchange",
    headers: {
      host,
      origin,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin"
    },
    payload: { capability }
  });
  return {
    response,
    cookie: response.headers["set-cookie"],
    csrf: response.json<{ csrf_token: string }>().csrf_token
  };
}

describe("Studio Control API", () => {
  it("serves adapter catalog, preview, routing definition, and simulation", async () => {
    const { server, sessions } = await fixture();
    const session = await localSession(server, sessions.bootstrapCapability());
    const readHeaders = { host, cookie: session.cookie };
    const mutationHeaders = {
      ...readHeaders,
      origin,
      "content-type": "application/json",
      "x-luna-csrf": session.csrf
    };

    const adapters = await server.inject({
      method: "GET",
      url: "/api/studio/v1/input-adapters",
      headers: readHeaders
    });
    const preview = await server.inject({
      method: "POST",
      url: "/api/studio/v1/input-adapters/github-pr-url/preview",
      headers: mutationHeaders,
      payload: {
        input: { kind: "cli", value: "https://github.com/acme/repo/pull/1" },
        acknowledged_effects: []
      }
    });
    const routing = await server.inject({
      method: "GET",
      url: "/api/studio/v1/configuration/routing",
      headers: readHeaders
    });
    const simulation = await server.inject({
      method: "POST",
      url: "/api/studio/v1/routing/simulate",
      headers: mutationHeaders,
      payload: {
        invocation: {
          version: "2026-06",
          source: "github",
          event: "pull_request"
        }
      }
    });

    expect(adapters.statusCode).toBe(200);
    expect(adapters.json()).toMatchObject({
      adapters: [{ id: "github-pr-url", source: "github" }]
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      adapter_id: "github-pr-url",
      invocation: { source: "github", event: "pull_request" },
      redacted_fields: ["payload"]
    });
    expect(routing.statusCode).toBe(200);
    expect(routing.json()).toEqual(routingDefinition);
    expect(simulation.statusCode).toBe(200);
    expect(simulation.json()).toMatchObject({
      status: "matched",
      target: { type: "workflow", id: "code-review" }
    });
    await server.close();
  });

  it("maps adapter failures without exposing their causes", async () => {
    const secret = "adapter-secret-must-not-leak";
    const { server, sessions } = await fixture({
      inputRouting: {
        ...defaultInputRouting,
        previewInputAdapter: async () => {
          throw new StudioAdapterPreviewError(
            "studio_adapter_preview_failed",
            `unsafe ${secret}`
          );
        }
      }
    });
    const session = await localSession(server, sessions.bootstrapCapability());
    const response = await server.inject({
      method: "POST",
      url: "/api/studio/v1/input-adapters/github-pr-url/preview",
      headers: {
        host,
        origin,
        cookie: session.cookie,
        "content-type": "application/json",
        "x-luna-csrf": session.csrf
      },
      payload: {
        input: { kind: "cli", value: "opaque" },
        acknowledged_effects: []
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: {
        code: "studio_adapter_preview_failed",
        message: "The adapter preview failed",
        details: {}
      }
    });
    expect(response.body).not.toContain(secret);
    await server.close();
  });

  it("validates Host globally for health, assets, and not-found responses", async () => {
    const { server } = await fixture();
    const health = await server.inject({
      method: "GET",
      url: "/health",
      headers: { host }
    });
    const asset = await server.inject({
      method: "GET",
      url: "/assets/app.js",
      headers: { host }
    });
    const reboundAsset = await server.inject({
      method: "GET",
      url: "/assets/app.js",
      headers: { host: "attacker.example" }
    });
    const reboundMissing = await server.inject({
      method: "GET",
      url: "/does-not-exist",
      headers: { host: "attacker.example" }
    });

    expect(health.statusCode).toBe(200);
    expect(asset.statusCode).toBe(200);
    expect(reboundAsset.statusCode).toBe(403);
    expect(reboundMissing.statusCode).toBe(403);
    expect(health.headers["access-control-allow-origin"]).toBeUndefined();
    await server.close();
  });

  it("uses a React-compatible CSP without enabling inline scripts", async () => {
    const { server } = await fixture();
    const response = await server.inject({
      method: "GET",
      url: "/assets/app.js",
      headers: { host }
    });
    const csp = response.headers["content-security-policy"];

    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src-elem 'self'");
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
    await server.close();
  });

  it("exchanges the startup capability and protects every catalog read", async () => {
    const { server, sessions } = await fixture();
    const unauthenticated = await server.inject({
      method: "GET",
      url: "/api/studio/v1/library",
      headers: { host }
    });
    const session = await localSession(
      server,
      sessions.bootstrapCapability()
    );
    const authenticated = await server.inject({
      method: "GET",
      url: "/api/studio/v1/library",
      headers: { host, cookie: session.cookie }
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(session.response.statusCode).toBe(200);
    expect(session.cookie).toContain("HttpOnly");
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({ registrations: [] });
    await server.close();
  });

  it("validates strict request bodies without leaking schema details", async () => {
    const { server } = await fixture();
    const response = await server.inject({
      method: "POST",
      url: "/api/studio/v1/session/exchange",
      headers: {
        host,
        origin,
        "content-type": "application/json"
      },
      payload: { capability: "candidate", unexpected: "private-value" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "studio_request_invalid",
        message: "The Studio request body is invalid",
        details: {},
        request_id: expect.any(String)
      }
    });
    expect(response.body).not.toContain("unexpected");
    expect(response.body).not.toContain("private-value");
    expect(response.body).not.toContain("stack");
    await server.close();
  });

  it("maps malformed JSON, body limits, and not-found through the error contract", async () => {
    const { server } = await fixture({ bodyLimit: 96 });
    const malformed = await server.inject({
      method: "POST",
      url: "/api/studio/v1/session/exchange",
      headers: { host, origin, "content-type": "application/json" },
      payload: "{"
    });
    const oversizedSecret = "secret-body-value".repeat(20);
    const oversized = await server.inject({
      method: "POST",
      url: "/api/studio/v1/session/exchange",
      headers: { host, origin, "content-type": "application/json" },
      payload: { capability: oversizedSecret }
    });
    const missing = await server.inject({
      method: "GET",
      url: "/does-not-exist?raw=must-not-echo",
      headers: { host }
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: { code: "studio_request_invalid", details: {} }
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: { code: "studio_request_too_large", details: {} }
    });
    expect(oversized.body).not.toContain(oversizedSecret);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: "studio_not_found", details: {} }
    });
    expect(missing.body).not.toContain("must-not-echo");
    await server.close();
  });

  it("maps invalid query projections to 500 instead of serializing raw data", async () => {
    const invalidCapabilities = (() => ({
      technical_fingerprint: `sha256:${"1".repeat(64)}`,
      presentation_fingerprint: `sha256:${"2".repeat(64)}`,
      capabilities: [],
      registrations: [],
      raw_secret: "must-not-leak"
    })) as unknown as StudioControlApiQueries["capabilities"];
    const { server, sessions } = await fixture({
      queries: { ...defaultQueries, capabilities: invalidCapabilities }
    });
    const session = await localSession(server, sessions.bootstrapCapability());
    const response = await server.inject({
      method: "GET",
      url: "/api/studio/v1/library",
      headers: { host, cookie: session.cookie }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: "studio_internal_error", details: {} }
    });
    expect(response.body).not.toContain("raw_secret");
    expect(response.body).not.toContain("must-not-leak");
    await server.close();
  });

  it("enforces origin, JSON, and CSRF on protected mutations", async () => {
    const { server, sessions } = await fixture();
    const session = await localSession(
      server,
      sessions.bootstrapCapability()
    );
    const baseHeaders = {
      host,
      origin,
      cookie: session.cookie,
      "content-type": "application/json"
    };
    const missingCsrf = await server.inject({
      method: "POST",
      url: "/api/studio/v1/test-mutation",
      headers: baseHeaders,
      payload: {}
    });
    const valid = await server.inject({
      method: "POST",
      url: "/api/studio/v1/test-mutation",
      headers: { ...baseHeaders, "x-luna-csrf": session.csrf },
      payload: {}
    });

    expect(missingCsrf.statusCode).toBe(403);
    expect(valid.statusCode).toBe(200);
    await server.close();
  });

  it("recovers by rotating CSRF from the same-origin authenticated session", async () => {
    const { server, sessions } = await fixture();
    const bootstrap = sessions.bootstrapCapability();
    const session = await localSession(server, bootstrap);
    const rotation = await server.inject({
      method: "POST",
      url: "/api/studio/v1/session/csrf",
      headers: {
        host,
        origin,
        cookie: session.cookie,
        "content-type": "application/json",
        "x-luna-csrf": session.csrf,
        "sec-fetch-site": "same-origin"
      },
      payload: {}
    });
    const rotatedCsrf = rotation.json<{ csrf_token: string }>().csrf_token;
    const mutationHeaders = {
      host,
      origin,
      cookie: session.cookie,
      "content-type": "application/json"
    };
    const oldToken = await server.inject({
      method: "POST",
      url: "/api/studio/v1/test-mutation",
      headers: { ...mutationHeaders, "x-luna-csrf": session.csrf },
      payload: {}
    });
    const newToken = await server.inject({
      method: "POST",
      url: "/api/studio/v1/test-mutation",
      headers: { ...mutationHeaders, "x-luna-csrf": rotatedCsrf },
      payload: {}
    });
    const reusedBootstrap = await server.inject({
      method: "POST",
      url: "/api/studio/v1/session/exchange",
      headers: { host, origin, "content-type": "application/json" },
      payload: { capability: bootstrap }
    });

    expect(rotation.statusCode).toBe(200);
    expect(rotatedCsrf).not.toBe(session.csrf);
    expect(oldToken.statusCode).toBe(403);
    expect(newToken.statusCode).toBe(200);
    expect(reusedBootstrap.statusCode).toBe(401);
    await server.close();
  });

  it("rejects CSRF rotation without the session or same origin", async () => {
    const { server, sessions } = await fixture();
    const session = await localSession(server, sessions.bootstrapCapability());
    const withoutSession = await server.inject({
      method: "POST",
      url: "/api/studio/v1/session/csrf",
      headers: { host, origin, "content-type": "application/json" },
      payload: {}
    });
    const crossOrigin = await server.inject({
      method: "POST",
      url: "/api/studio/v1/session/csrf",
      headers: {
        host,
        origin: "https://evil.example",
        cookie: session.cookie,
        "x-luna-csrf": session.csrf,
        "content-type": "application/json"
      },
      payload: {}
    });

    expect(withoutSession.statusCode).toBe(401);
    expect(crossOrigin.statusCode).toBe(403);
    await server.close();
  });

  it("rejects CSRF rotation without the current CSRF token", async () => {
    const { server, sessions } = await fixture();
    const session = await localSession(server, sessions.bootstrapCapability());
    const baseHeaders = {
      host,
      origin,
      cookie: session.cookie,
      "content-type": "application/json"
    };
    const missing = await server.inject({
      method: "POST",
      url: "/api/studio/v1/session/csrf",
      headers: baseHeaders,
      payload: {}
    });
    const wrong = await server.inject({
      method: "POST",
      url: "/api/studio/v1/session/csrf",
      headers: { ...baseHeaders, "x-luna-csrf": "wrong" },
      payload: {}
    });

    expect(missing.statusCode).toBe(403);
    expect(wrong.statusCode).toBe(403);
    await server.close();
  });
});
