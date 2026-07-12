import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type {
  StudioAgentTestLaunchContext,
  StudioAgentTestPlanRequest
} from "../../../src/studio/contracts/agent-test-bench.js";
import {
  registerStudioControlApi,
  type StudioControlApiQueries
} from "../../../src/studio/server/control-api.js";
import type { StudioAgentTestBenchControl } from "../../../src/studio/server/routes/agent-test-bench.js";
import type { StudioInputRoutingControl } from "../../../src/studio/server/routes/input-routing.js";
import { StudioLocalSessionManager } from "../../../src/studio/server/security/local-session.js";

const host = "127.0.0.1:43110";
const origin = "http://127.0.0.1:43110";
const planId = `atp_${"p".repeat(32)}`;
const confirmationToken = "t".repeat(48);
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

const scope = {
  real_model_call: true as const,
  local_tools_executed: false as const,
  mcp_executed: false as const,
  subagents_executed: false as const,
  workflow_context_included: false as const,
  repository_context_included: false as const,
  agent_context_files_included: false as const,
  workflow_equivalent: false as const,
  statement: "Isolated smoke test; this is not a workflow execution."
};

const resolution = {
  target: {
    kind: "installed" as const,
    agent_id: "reviewer",
    agent_revision: digest("a"),
    requested_revision: digest("a")
  },
  agent_mode: "read_only" as const,
  default_model_profile_id: "default",
  selected_model_profile: {
    id: "default",
    model: "provider/model",
    reasoning_effort: "medium" as const
  },
  available_model_profiles: [{
    id: "default",
    model: "provider/model",
    reasoning_effort: "medium" as const
  }],
  runtime: {
    id: "runtime",
    display_name: "Runtime",
    supported_tool_protocols: ["local" as const],
    supported_runtime_requirements: [],
    configuration_hash: digest("b")
  },
  tools: [],
  mcp_servers: [],
  subagents: [],
  declared_skills: [],
  declared_agent_context_files: [],
  runtime_requirements: [],
  blockers: [],
  catalog_fingerprint: digest("c"),
  output_schema_hash: digest("d"),
  instructions_hash: digest("e"),
  scope
};

const privateFixture = "fixture-private-must-not-leak";
const privateContext = "context-private-must-not-leak";
const planRequest: StudioAgentTestPlanRequest = {
  target: {
    kind: "installed",
    agent_id: "reviewer",
    revision: digest("a")
  },
  fixture: { payload: privateFixture },
  context: { kind: "json", value: { policy: privateContext } }
};

async function fixture() {
  const contexts: StudioAgentTestLaunchContext[] = [];
  const requests: StudioAgentTestPlanRequest[] = [];
  const control: StudioAgentTestBenchControl = {
    plan: async (request, context) => {
      requests.push(request);
      contexts.push(context);
      return {
        plan_id: planId,
        created_at: "2026-07-11T12:00:00.000Z",
        expires_at: "2026-07-11T12:05:00.000Z",
        snapshot_hash: digest("f"),
        fixture_hash: digest("6"),
        context_hash: digest("7"),
        resolution,
        execution: {
          available: true,
          confirmation_required: true,
          confirmation_token: confirmationToken
        }
      };
    },
    execute: async (acceptedPlanId, _request, context) => {
      contexts.push(context);
      return {
        plan_id: acceptedPlanId,
        snapshot_hash: digest("f"),
        completed_at: "2026-07-11T12:00:01.000Z",
        output: { status: "ok" },
        output_schema_validated: true,
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          total_tokens: 11,
          cost: { total: 0.002, unit: "USD" }
        },
        scope
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
    agentTest: control
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
    requests,
    cookie: exchange.headers["set-cookie"],
    csrf: exchange.json<{ csrf_token: string }>().csrf_token
  };
}

describe("Studio agent test bench routes", () => {
  it("binds preview and synchronous execution to the server session", async () => {
    const { server, contexts, requests, cookie, csrf } = await fixture();
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
        url: "/api/studio/v1/agent-test-plans",
        headers: { host, origin, cookie, "content-type": "application/json" },
        payload: planRequest
      });
      const forgedBinding = await server.inject({
        method: "POST",
        url: "/api/studio/v1/agent-test-plans",
        headers,
        payload: { ...planRequest, actor_binding: "browser-controlled" }
      });
      const planned = await server.inject({
        method: "POST",
        url: "/api/studio/v1/agent-test-plans",
        headers,
        payload: planRequest
      });
      const executed = await server.inject({
        method: "POST",
        url: `/api/studio/v1/agent-test-plans/${planId}/execute`,
        headers,
        payload: {
          confirmation_token: confirmationToken,
          confirmation: {
            kind: "local_explicit",
            real_model_call_confirmed: true,
            isolated_smoke_scope_confirmed: true
          }
        }
      });

      expect(missingCsrf.statusCode).toBe(403);
      expect(forgedBinding.statusCode).toBe(400);
      expect(planned.statusCode).toBe(200);
      expect(planned.body).not.toContain(privateFixture);
      expect(planned.body).not.toContain(privateContext);
      expect(planned.json()).toMatchObject({
        plan_id: planId,
        execution: {
          available: true,
          confirmation_token: confirmationToken
        }
      });
      expect(planned.json()).not.toHaveProperty("fixture");
      expect(planned.json()).not.toHaveProperty("context");
      expect(executed.statusCode).toBe(200);
      expect(executed.json()).toMatchObject({
        plan_id: planId,
        output: { status: "ok" },
        output_schema_validated: true,
        usage: { total_tokens: 11, cost: { total: 0.002, unit: "USD" } },
        scope: { workflow_equivalent: false }
      });
      expect(executed.body).not.toContain(confirmationToken);
      expect(requests).toEqual([planRequest]);
      expect(contexts).toHaveLength(2);
      expect(Object.keys(contexts[0] ?? {}).sort()).toEqual([
        "actor_binding",
        "request_id"
      ]);
      expect(contexts[0]?.actor_binding).toBe(contexts[1]?.actor_binding);
      expect(contexts[0]?.actor_binding).not.toBe(csrf);
      expect(contexts[0]?.request_id).not.toBe(contexts[1]?.request_id);
      expect(contexts[0]?.request_id).toMatch(/^request-[a-f0-9]{64}$/);
      expect(planned.body).not.toContain(contexts[0]?.actor_binding ?? "missing");
      expect(executed.body).not.toContain(contexts[0]?.actor_binding ?? "missing");
    } finally {
      await server.close();
    }
  });

  it("rejects execution without both native confirmations", async () => {
    const { server, contexts, cookie, csrf } = await fixture();
    try {
      const response = await server.inject({
        method: "POST",
        url: `/api/studio/v1/agent-test-plans/${planId}/execute`,
        headers: {
          host,
          origin,
          cookie,
          "content-type": "application/json",
          "x-luna-csrf": csrf
        },
        payload: {
          confirmation_token: confirmationToken,
          confirmation: {
            kind: "local_explicit",
            real_model_call_confirmed: true,
            isolated_smoke_scope_confirmed: false
          }
        }
      });

      expect(response.statusCode).toBe(400);
      expect(contexts).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
