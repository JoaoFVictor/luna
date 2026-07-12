import Fastify from "fastify";
import type { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { StudioLocalPrincipal } from "../../../src/studio/contracts/control-api.js";
import type { StudioConfigurationControl } from "../../../src/studio/server/routes/configuration.js";
import { registerStudioConfigurationRoutes } from "../../../src/studio/server/routes/configuration.js";

const WORKFLOW_ID = "review";
const DRAFT_ID = "1d3022f8-324e-4923-88fa-259a5ea1f356";
const OPERATION_ID = "8baae063-2b22-4375-b54c-dc56526dd3bc";
const DIGEST = `sha256:${"a".repeat(64)}`;
const ETAG = `"studio-draft:${DRAFT_ID}:1:${DIGEST}"`;
const TIMESTAMP = "2026-07-11T01:00:00.000Z";
const principal: StudioLocalPrincipal = {
  id: "local-user",
  authentication: "local-session"
};

const configuration = {
  workflow_id: WORKFLOW_ID,
  status: "ready" as const,
  declared: true,
  config_present: true,
  schema_present: true,
  raw_yaml_enabled: false as const,
  file_reference: "config:review.yaml",
  schema_reference: "project:workflows/review/config.schema.json",
  installed_revision: DIGEST,
  schema_summary: {
    total_leaf_count: 2,
    classified_field_count: 1,
    unclassified_field_count: 1,
    unsupported_classified_field_count: 0
  },
  fields: [
    {
      path: ["settings", "enabled"],
      expression: "$.config.settings.enabled",
      value_type: "boolean" as const,
      exposure: "editable" as const,
      required: true,
      present: true,
      value: false
    }
  ],
  references: [{ expression: "$.config.settings.enabled" }],
  diagnostics: []
};

const draft = {
  draft_id: DRAFT_ID,
  record_revision: 1,
  content_revision: 1,
  status: "dirty" as const,
  draft_hash: DIGEST,
  etag: ETAG,
  configuration,
  created_at: TIMESTAMP,
  updated_at: TIMESTAMP
};

function controlFixture(): StudioConfigurationControl & {
  [K in keyof StudioConfigurationControl]: ReturnType<typeof vi.fn>;
} {
  return {
    getWorkflowConfiguration: vi.fn(async () => configuration),
    createWorkflowConfigurationDraft: vi.fn(async () => draft),
    getWorkflowConfigurationDraft: vi.fn(async () => draft),
    patchWorkflowConfigurationDraft: vi.fn(async () => draft),
    validateWorkflowConfigurationDraft: vi.fn(async () => ({
      draft,
      validation: {
        status: "valid" as const,
        diagnostics: [],
        validated_at: TIMESTAMP
      }
    })),
    planWorkflowConfigurationApply: vi.fn(async () => ({
      status: "ready" as const,
      draft_id: DRAFT_ID,
      record_revision: 1,
      content_revision: 1,
      draft_hash: DIGEST,
      changes: [
        {
          path: ["settings", "enabled"],
          before_present: true,
          before: false,
          after_present: true,
          after: true
        }
      ],
      conflicts: [],
      plan_token: "p".repeat(32),
      expires_at: "2026-07-11T01:02:00.000Z"
    })),
    applyWorkflowConfigurationDraft: vi.fn(async () => ({
      status: "committed" as const,
      operation_id: OPERATION_ID,
      draft_id: DRAFT_ID,
      record_revision: 1,
      draft_hash: DIGEST,
      resource_revisions: { "config:review": DIGEST },
      files: [
        {
          file: { root: "config" as const, path: "review.yaml" },
          sha256: DIGEST
        }
      ],
      committed_at: TIMESTAMP,
      idempotent_replay: false
    })),
    models: vi.fn(async () => ({
      editing: "read_only" as const,
      profiles: [],
      diagnostics: []
    })),
    repositories: vi.fn(async () => ({
      editing: "read_only" as const,
      confinement_policy: "not_configured" as const,
      repositories: [],
      diagnostics: []
    })),
    providers: vi.fn(async () => ({
      editing: "read_only" as const,
      providers: []
    })),
    testProviderConnection: vi.fn(async () => ({
      provider_id: "github",
      probe_id: "github",
      status: "healthy" as const,
      checked_at: TIMESTAMP,
      effects: ["credential_read" as const, "network_read" as const, "process_execution" as const],
      timeout_ms: 10_000,
      summary: "GitHub respondeu com uma conta autenticada."
    })),
    runtime: vi.fn(async () => ({
      editing: "read_only" as const,
      workflow_runtime_id: "langgraph",
      agent_runtime_id: "pi",
      workspace_strategy: "git_worktree",
      plugin_count: 0,
      option_values_redacted: true as const
    }))
  };
}

function parseRequest<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown
): T {
  return schema.parse(value);
}

async function serverFor(control: StudioConfigurationControl) {
  const server = Fastify({ logger: false });
  server.setErrorHandler((_error, _request, reply) => {
    void reply.code(400).send({ error: "invalid request" });
  });
  await registerStudioConfigurationRoutes(server, {
    apiPrefix: "/api/studio/v1",
    control,
    principalFor: () => principal,
    parseRequest
  });
  return server;
}

describe("Studio configuration routes", () => {
  it("exposes only the safe workflow projection and read-only posture", async () => {
    const control = controlFixture();
    const server = await serverFor(control);
    const [workflow, models, repositories, providers, runtime] =
      await Promise.all([
        server.inject({
          method: "GET",
          url: `/api/studio/v1/configuration/workflows/${WORKFLOW_ID}`
        }),
        server.inject({ method: "GET", url: "/api/studio/v1/configuration/models" }),
        server.inject({
          method: "GET",
          url: "/api/studio/v1/configuration/repositories"
        }),
        server.inject({
          method: "GET",
          url: "/api/studio/v1/configuration/providers"
        }),
        server.inject({ method: "GET", url: "/api/studio/v1/configuration/runtime" })
      ]);

    expect(workflow.statusCode).toBe(200);
    expect(workflow.json()).toMatchObject({
      workflow_id: WORKFLOW_ID,
      raw_yaml_enabled: false,
      fields: [{ path: ["settings", "enabled"], value: false }]
    });
    expect(models.json()).toMatchObject({ editing: "read_only" });
    expect(repositories.json()).toMatchObject({
      editing: "read_only",
      confinement_policy: "not_configured"
    });
    expect(providers.json()).toMatchObject({ editing: "read_only" });
    expect(runtime.json()).toMatchObject({
      editing: "read_only",
      option_values_redacted: true
    });
    expect(control.getWorkflowConfiguration).toHaveBeenCalledWith(
      principal,
      WORKFLOW_ID
    );
    await server.close();
  });

  it("passes ETags through create, patch, validate, plan, and confirmed apply", async () => {
    const control = controlFixture();
    const server = await serverFor(control);
    const base = `/api/studio/v1/configuration/workflows/${WORKFLOW_ID}/drafts`;
    const created = await server.inject({
      method: "POST",
      url: base,
      payload: {}
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe(ETAG);
    expect(created.headers.location).toBe(`${base}/${DRAFT_ID}`);

    const fetched = await server.inject({ method: "GET", url: `${base}/${DRAFT_ID}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers.etag).toBe(ETAG);

    const patched = await server.inject({
      method: "PATCH",
      url: `${base}/${DRAFT_ID}`,
      headers: { "if-match": ETAG },
      payload: {
        updates: [{ path: ["settings", "enabled"], value: true }]
      }
    });
    expect(patched.statusCode).toBe(200);
    expect(control.patchWorkflowConfigurationDraft).toHaveBeenCalledWith(
      principal,
      WORKFLOW_ID,
      DRAFT_ID,
      { updates: [{ path: ["settings", "enabled"], value: true }] },
      ETAG
    );

    const validated = await server.inject({
      method: "POST",
      url: `${base}/${DRAFT_ID}/validate`,
      headers: { "if-match": ETAG },
      payload: {}
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.headers.etag).toBe(ETAG);

    const plan = await server.inject({
      method: "POST",
      url: `${base}/${DRAFT_ID}/plan-apply`,
      payload: {}
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({
      status: "ready",
      changes: [{ path: ["settings", "enabled"], before: false, after: true }]
    });

    const applied = await server.inject({
      method: "POST",
      url: `${base}/${DRAFT_ID}/apply`,
      headers: { "if-match": ETAG },
      payload: {
        plan_token: "p".repeat(32),
        idempotency_key: "configuration-review"
      }
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      status: "committed",
      operation_id: OPERATION_ID
    });
    expect(control.applyWorkflowConfigurationDraft).toHaveBeenCalledWith(
      principal,
      WORKFLOW_ID,
      DRAFT_ID,
      {
        planToken: "p".repeat(32),
        idempotencyKey: "configuration-review",
        ifMatch: ETAG
      }
    );
    await server.close();
  });

  it("runs a dedicated provider probe without adapter input", async () => {
    const control = controlFixture();
    const server = await serverFor(control);
    const response = await server.inject({
      method: "POST",
      url: "/api/studio/v1/configuration/providers/github/probe",
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider_id: "github",
      probe_id: "github",
      status: "healthy",
      effects: ["credential_read", "network_read", "process_execution"]
    });
    expect(control.testProviderConnection).toHaveBeenCalledWith(
      principal,
      "github",
      expect.any(AbortSignal)
    );
    await server.close();
  });

  it("reports an unknown provider probe as explicitly unsupported", async () => {
    const control = controlFixture();
    control.testProviderConnection.mockResolvedValue({
      provider_id: "unknown",
      status: "unsupported",
      summary: "Este provider não possui um teste de conexão dedicado."
    });
    const server = await serverFor(control);
    const response = await server.inject({
      method: "POST",
      url: "/api/studio/v1/configuration/providers/unknown/probe",
      payload: {}
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      provider_id: "unknown",
      status: "unsupported",
      summary: "Este provider não possui um teste de conexão dedicado."
    });
    await server.close();
  });

  it("rejects client-supplied raw YAML, revisions, and plan fields", async () => {
    const control = controlFixture();
    const server = await serverFor(control);
    const base = `/api/studio/v1/configuration/workflows/${WORKFLOW_ID}/drafts/${DRAFT_ID}`;
    const patch = await server.inject({
      method: "PATCH",
      url: base,
      headers: { "if-match": ETAG },
      payload: {
        updates: [{ path: ["settings", "enabled"], value: true }],
        raw_yaml: "settings:\n  secret: leak",
        record_revision: 99
      }
    });
    const apply = await server.inject({
      method: "POST",
      url: `${base}/apply`,
      headers: { "if-match": ETAG },
      payload: {
        plan_token: "p".repeat(32),
        idempotency_key: "configuration-review",
        source_hash: DIGEST
      }
    });
    expect(patch.statusCode).toBe(400);
    expect(apply.statusCode).toBe(400);
    expect(control.patchWorkflowConfigurationDraft).not.toHaveBeenCalled();
    expect(control.applyWorkflowConfigurationDraft).not.toHaveBeenCalled();
    await server.close();
  });
});
