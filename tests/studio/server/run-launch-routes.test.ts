import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { StudioRunLaunchContext } from "../../../src/studio/contracts/run-launch.js";
import { STUDIO_STANDARD_EXECUTION_PROFILE_HASH } from "../../../src/studio/contracts/manual-test-data.js";
import {
  registerStudioControlApi,
  type StudioControlApiQueries
} from "../../../src/studio/server/control-api.js";
import type { StudioInputRoutingControl } from "../../../src/studio/server/routes/input-routing.js";
import type { StudioRunLaunchControl } from "../../../src/studio/server/routes/run-launch.js";
import { StudioLocalSessionManager } from "../../../src/studio/server/security/local-session.js";

const host = "127.0.0.1:43110";
const origin = "http://127.0.0.1:43110";
const planId = `rp_${"p".repeat(32)}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;

const queries: StudioControlApiQueries = {
  capabilities: () => ({
    technical_fingerprint: digest("1"),
    presentation_fingerprint: digest("2"),
    capabilities: [],
    registrations: []
  }),
  agents: () => ({
    status: "complete",
    fingerprint: digest("3"),
    agents: [],
    diagnostics: []
  }),
  workflows: () => ({
    status: "complete",
    fingerprint: digest("4"),
    workflows: [],
    diagnostics: []
  })
};

function unusedRoute(): never {
  throw new Error("Unused input-routing fixture method");
}

const inputRouting: StudioInputRoutingControl = {
  listInputAdapters: () => ({ adapters: [] }),
  previewInputAdapter: unusedRoute,
  previewInputRoute: unusedRoute,
  routingDefinition: unusedRoute,
  simulateRouting: unusedRoute
};

const opaqueAdapterInput = "provider://private/reference?token=must-not-leak";
const planRequest = {
  kind: "adapter" as const,
  adapter_id: "private-adapter",
  input: { kind: "cli" as const, value: opaqueAdapterInput },
  acknowledged_effects: []
};

async function fixture() {
  const contexts: StudioRunLaunchContext[] = [];
  const control: StudioRunLaunchControl = {
    plan: async (request, context) => {
      contexts.push(context);
      return {
        plan_id: planId,
        created_at: "2026-07-11T12:00:00.000Z",
        expires_at: "2026-07-11T12:05:00.000Z",
        workflow_id: "pinned-workflow",
        definition_source: { kind: "installed" },
        execution_scope: { kind: "workflow" },
        mode: "read_only",
        workflow_revision: digest("a"),
        definition_bundle_hash: digest("b"),
        catalog_fingerprint: digest("c"),
        execution_snapshot_hash: digest("d"),
        invocation_hash: digest("e"),
        config_hash: digest("f"),
        repository_required: false,
        input_provenance: request.kind === "adapter"
          ? {
              kind: "adapter",
              adapter_id: request.adapter_id,
              adapter_input_hash: digest("9")
            }
          : { kind: "invocation" },
        execution_profile: { kind: "standard" },
        execution_profile_hash: STUDIO_STANDARD_EXECUTION_PROFILE_HASH,
        potential_effects: [],
        resolved_effects: [],
        effect_uncertainties: [],
        warnings: [],
        confirmation_required: false,
        confirmation_token: "t".repeat(48)
      };
    },
    execute: async (acceptedPlanId, _request, context) => {
      contexts.push(context);
      return {
        accepted: true,
        dispatch_status: "queued",
        run_id: "server-bound-run",
        plan_id: acceptedPlanId,
        execution_snapshot_hash: digest("d"),
        accepted_at: "2026-07-11T12:00:01.000Z"
      };
    }
  };
  const sessions = new StudioLocalSessionManager({
    allowedHosts: [host],
    allowedOrigins: [origin]
  });
  const server = Fastify({ logger: false });
  await registerStudioControlApi(server, {
    sessions,
    queries,
    inputRouting,
    runLaunch: control
  });
  await server.ready();
  const exchange = await server.inject({
    method: "POST",
    url: "/api/studio/v1/session/exchange",
    headers: {
      host,
      origin,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin"
    },
    payload: { capability: sessions.bootstrapCapability() }
  });
  return {
    server,
    contexts,
    cookie: exchange.headers["set-cookie"],
    csrf: exchange.json<{ csrf_token: string }>().csrf_token
  };
}

describe("Studio run launch routes", () => {
  it("binds plan and execute to the server session and returns 202", async () => {
    const { server, contexts, cookie, csrf } = await fixture();
    const headers = {
      host,
      origin,
      cookie,
      "content-type": "application/json",
      "x-luna-csrf": csrf
    };
    try {
      const missingCsrf = await server.inject({
        method: "POST",
        url: "/api/studio/v1/run-plans",
        headers: { host, origin, cookie, "content-type": "application/json" },
        payload: planRequest
      });
      const forgedBinding = await server.inject({
        method: "POST",
        url: "/api/studio/v1/run-plans",
        headers,
        payload: { ...planRequest, actor_binding: "browser-controlled" }
      });
      const planned = await server.inject({
        method: "POST",
        url: "/api/studio/v1/run-plans",
        headers,
        payload: planRequest
      });
      const plannedInvocation = await server.inject({
        method: "POST",
        url: "/api/studio/v1/run-plans",
        headers,
        payload: {
          kind: "invocation",
          invocation: {
            version: "2026-06",
            source: "manual",
            event: "studio",
            payload: { secret: "private-direct-invocation" }
          }
        }
      });
      const accepted = await server.inject({
        method: "POST",
        url: `/api/studio/v1/run-plans/${planId}/execute`,
        headers,
        payload: {
          confirmation_token: "t".repeat(48),
          idempotency_key: "browser-idempotency-key",
          confirmation: {
            kind: "local_explicit",
            real_run_confirmed: true,
            listed_effects_confirmed: true
          }
        }
      });

      expect(missingCsrf.statusCode).toBe(403);
      expect(forgedBinding.statusCode).toBe(400);
      expect(planned.statusCode).toBe(200);
      expect(planned.body).not.toContain(opaqueAdapterInput);
      expect(planned.body).not.toContain("must-not-leak");
      expect(planned.json()).toMatchObject({
        input_provenance: {
          kind: "adapter",
          adapter_id: "private-adapter",
          adapter_input_hash: digest("9")
        }
      });
      expect(planned.json()).not.toHaveProperty("config");
      expect(planned.json()).not.toHaveProperty("invocation");
      expect(plannedInvocation.statusCode).toBe(200);
      expect(plannedInvocation.body).not.toContain("private-direct-invocation");
      expect(plannedInvocation.json()).toMatchObject({
        input_provenance: { kind: "invocation" }
      });
      expect(plannedInvocation.json()).not.toHaveProperty("config");
      expect(plannedInvocation.json()).not.toHaveProperty("invocation");
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toMatchObject({
        accepted: true,
        dispatch_status: "queued",
        run_id: "server-bound-run",
        plan_id: planId
      });
      expect(accepted.body).not.toContain("browser-idempotency-key");
      expect(accepted.body).not.toContain("t".repeat(48));
      expect(accepted.json()).not.toHaveProperty("invocation");
      expect(accepted.json()).not.toHaveProperty("config");
      expect(contexts).toHaveLength(3);
      expect(contexts[0]?.actor_id).toBe("local-user");
      expect(contexts[0]?.actor_binding).toBe(contexts[1]?.actor_binding);
      expect(contexts[0]?.actor_binding).toBe(contexts[2]?.actor_binding);
      expect(contexts[0]?.actor_binding).not.toBe(csrf);
      expect(contexts[0]?.request_id).not.toBe(contexts[1]?.request_id);
      expect(contexts[0]?.request_id).not.toBe(contexts[2]?.request_id);
      expect(contexts[1]?.request_id).not.toBe(contexts[2]?.request_id);
      expect(contexts[0]?.request_id).toMatch(/^request-[a-f0-9]{64}$/);
      expect(planned.body).not.toContain(contexts[0]?.actor_binding ?? "missing");
      expect(plannedInvocation.body).not.toContain(
        contexts[0]?.actor_binding ?? "missing"
      );
      expect(accepted.body).not.toContain(
        contexts[0]?.actor_binding ?? "missing"
      );
    } finally {
      await server.close();
    }
  });
});
