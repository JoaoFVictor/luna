import Fastify from "fastify";
import type { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { StudioLocalPrincipal } from "../../../src/studio/contracts/control-api.js";
import type { StudioDraftItem } from "../../../src/studio/contracts/draft-authoring.js";
import type { StudioDraftAuthoringControl } from "../../../src/studio/server/routes/drafts.js";
import { registerStudioDraftAuthoringRoutes } from "../../../src/studio/server/routes/drafts.js";

const draftId = "5bbc0ae8-d9f1-4cc2-b704-8186c026ad38";
const operationId = "ec28368e-675d-45b8-b516-82f982582d66";
const digest =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const etag = `"studio-draft:${draftId}:1:${digest}"`;
const timestamp = "2026-07-10T12:00:00.000Z";
const principal: StudioLocalPrincipal = {
  id: "local-user",
  authentication: "local-session"
};

const item: StudioDraftItem = {
  draft_id: draftId,
  record_revision: 1,
  content_revision: 1,
  layout_revision: 0,
  primary_resource: { kind: "agent", id: "reviewer" },
  status: "dirty",
  draft_hash: digest,
  etag,
  files: [
    {
      file: { root: "project", path: "agents/reviewer/agent.yaml" },
      media_type: "application/yaml",
      state: "present",
      content: "id: reviewer\n"
    }
  ],
  created_at: timestamp,
  updated_at: timestamp
};

function validation(compiled: boolean) {
  return {
    draft: item,
    validation: {
      draft_id: draftId,
      record_revision: 1,
      content_revision: 1,
      layout_revision: 0,
      draft_hash: digest,
      status: "valid" as const,
      compiled,
      resources: [
        {
          resource: item.primary_resource,
          status: "valid" as const,
          revision: digest,
          diagnostics: []
        }
      ],
      diagnostics: [],
      validated_at: timestamp
    }
  };
}

function controlFixture(): StudioDraftAuthoringControl & {
  [K in keyof StudioDraftAuthoringControl]: ReturnType<typeof vi.fn>;
} {
  return {
    listDraftTemplates: vi.fn(() => ({ templates: [] })),
    createDraft: vi.fn(async () => item),
    listDrafts: vi.fn(async () => ({
      items: [
        {
          draft_id: draftId,
          record_revision: 1,
          content_revision: 1,
          layout_revision: 0,
          primary_resource: item.primary_resource,
          draft_hash: digest,
          status: "dirty" as const,
          updated_at: timestamp,
          etag
        }
      ],
      diagnostics: [],
      next_cursor: null
    })),
    getDraft: vi.fn(async () => item),
    patchDraft: vi.fn(async () => item),
    editDraftSource: vi.fn(async () => item),
    getDraftSourceView: vi.fn(async (_principal, _draftId, file) => ({
      file,
      value: { id: "reviewer" }
    })),
    deleteDraft: vi.fn(async () => undefined),
    validateDraft: vi.fn(async () => validation(false)),
    compileDraft: vi.fn(async () => validation(true)),
    planDraftApply: vi.fn(async () => ({
      status: "ready" as const,
      draft_id: draftId,
      record_revision: 1,
      content_revision: 1,
      draft_hash: digest,
      diff: [],
      conflicts: [],
      resources: [item.primary_resource],
      plan_token: "p".repeat(32),
      expires_at: "2026-07-10T12:02:00.000Z"
    })),
    applyDraft: vi.fn(async () => ({
      status: "committed" as const,
      operation_id: operationId,
      draft_id: draftId,
      record_revision: 1,
      draft_hash: digest,
      resource_revisions: { "agent:reviewer": digest },
      files: [],
      diff: [],
      committed_at: timestamp,
      idempotent_replay: false
    }))
  };
}

function parseRequest<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown
): T {
  return schema.parse(value);
}

async function serverFor(control: StudioDraftAuthoringControl) {
  const server = Fastify({ logger: false });
  server.setErrorHandler((_error, _request, reply) => {
    void reply.code(400).send({ error: "invalid request" });
  });
  await registerStudioDraftAuthoringRoutes(server, {
    apiPrefix: "/api/studio/v1",
    control,
    principalFor: () => principal,
    parseRequest
  });
  return server;
}

describe("Studio draft authoring routes", () => {
  it("lists the server-owned versioned draft templates", async () => {
    const control = controlFixture();
    const server = await serverFor(control);

    const response = await server.inject({
      method: "GET",
      url: "/api/studio/v1/draft-templates"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ templates: [] });
    expect(control.listDraftTemplates).toHaveBeenCalledWith(principal);
    await server.close();
  });

  it("registers create, list, item, patch, and delete with principal and ETags", async () => {
    const control = controlFixture();
    const server = await serverFor(control);

    const created = await server.inject({
      method: "POST",
      url: "/api/studio/v1/drafts",
      payload: {
        resource: { kind: "agent", id: "reviewer" },
        source: { mode: "blank", model_profile: "fast" }
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe(`/api/studio/v1/drafts/${draftId}`);
    expect(created.headers.etag).toBe(etag);
    expect(control.createDraft).toHaveBeenCalledWith(principal, {
      resource: { kind: "agent", id: "reviewer" },
      source: { mode: "blank", model_profile: "fast" }
    });

    const listed = await server.inject({
      method: "GET",
      url: "/api/studio/v1/drafts?limit=10"
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ items: [{ draft_id: draftId, etag }] });
    expect(control.listDrafts).toHaveBeenCalledWith(principal, { limit: 10 });

    const fetched = await server.inject({
      method: "GET",
      url: `/api/studio/v1/drafts/${draftId}`
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers.etag).toBe(etag);
    expect(control.getDraft).toHaveBeenCalledWith(principal, draftId);

    const sourceView = await server.inject({
      method: "GET",
      url: `/api/studio/v1/drafts/${draftId}/source-view?root=project&path=agents%2Freviewer%2Fagent.yaml`
    });
    expect(sourceView.statusCode).toBe(200);
    expect(sourceView.json()).toEqual({
      file: { root: "project", path: "agents/reviewer/agent.yaml" },
      value: { id: "reviewer" }
    });
    expect(control.getDraftSourceView).toHaveBeenCalledWith(
      principal,
      draftId,
      { root: "project", path: "agents/reviewer/agent.yaml" }
    );

    const patched = await server.inject({
      method: "PATCH",
      url: `/api/studio/v1/drafts/${draftId}`,
      headers: { "if-match": etag },
      payload: {
        edits: [
          {
            action: "write",
            file: { root: "project", path: "agents/reviewer/agent.yaml" },
            content: "id: reviewer\nmode: read_only\n"
          }
        ],
        layout: { selected: "reviewer" }
      }
    });
    expect(patched.statusCode).toBe(200);
    expect(control.patchDraft).toHaveBeenCalledWith(
      principal,
      draftId,
      expect.objectContaining({ layout: { selected: "reviewer" } }),
      etag
    );

    const sourceEdited = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${draftId}/source-edits`,
      headers: { "if-match": etag },
      payload: {
        file: { root: "project", path: "agents/reviewer/agent.yaml" },
        operations: [
          { op: "set", path: ["description"], value: "Reviewer agent" }
        ]
      }
    });
    expect(sourceEdited.statusCode).toBe(200);
    expect(sourceEdited.headers.etag).toBe(etag);
    expect(control.editDraftSource).toHaveBeenCalledWith(
      principal,
      draftId,
      {
        file: { root: "project", path: "agents/reviewer/agent.yaml" },
        operations: [
          { op: "set", path: ["description"], value: "Reviewer agent" }
        ]
      },
      etag
    );

    const deleted = await server.inject({
      method: "DELETE",
      url: `/api/studio/v1/drafts/${draftId}`,
      headers: { "if-match": etag }
    });
    expect(deleted.statusCode).toBe(204);
    expect(control.deleteDraft).toHaveBeenCalledWith(principal, draftId, etag);
    await server.close();
  });

  it("registers validate, compile, plan-apply, and apply as separate commands", async () => {
    const control = controlFixture();
    const server = await serverFor(control);

    const validated = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${draftId}/validate`,
      headers: { "if-match": etag },
      payload: {}
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.headers.etag).toBe(etag);
    expect(control.validateDraft).toHaveBeenCalledWith(principal, draftId, etag);

    const compiled = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${draftId}/compile`,
      headers: { "if-match": etag },
      payload: {}
    });
    expect(compiled.statusCode).toBe(200);
    expect(compiled.json()).toMatchObject({ validation: { compiled: true } });
    expect(control.compileDraft).toHaveBeenCalledWith(principal, draftId, etag);

    const planned = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${draftId}/plan-apply`,
      payload: {}
    });
    expect(planned.statusCode).toBe(200);
    expect(planned.json()).toMatchObject({ status: "ready" });
    expect(control.planDraftApply).toHaveBeenCalledWith(principal, draftId);

    const applied = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${draftId}/apply`,
      headers: { "if-match": etag },
      payload: {
        plan_token: "p".repeat(32),
        idempotency_key: "apply-reviewer"
      }
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ status: "committed" });
    expect(control.applyDraft).toHaveBeenCalledWith(principal, draftId, {
      planToken: "p".repeat(32),
      idempotencyKey: "apply-reviewer",
      ifMatch: etag
    });
    await server.close();
  });

  it("rejects client-supplied changesets, allowlists, hashes, and revisions", async () => {
    const control = controlFixture();
    const server = await serverFor(control);

    const create = await server.inject({
      method: "POST",
      url: "/api/studio/v1/drafts",
      payload: {
        resource: { kind: "agent", id: "reviewer" },
        source: { mode: "blank", model_profile: "fast" },
        allowed_files: [{ root: "project", path: "secrets.txt" }],
        changes: []
      }
    });
    expect(create.statusCode).toBe(400);
    expect(control.createDraft).not.toHaveBeenCalled();

    const missingModelProfile = await server.inject({
      method: "POST",
      url: "/api/studio/v1/drafts",
      payload: {
        resource: { kind: "agent", id: "reviewer" },
        source: { mode: "blank" }
      }
    });
    expect(missingModelProfile.statusCode).toBe(400);
    expect(control.createDraft).not.toHaveBeenCalled();

    const patch = await server.inject({
      method: "PATCH",
      url: `/api/studio/v1/drafts/${draftId}`,
      headers: { "if-match": etag },
      payload: {
        edits: [
          {
            action: "write",
            file: { root: "project", path: "agents/reviewer/agent.yaml" },
            content: "id: reviewer\n",
            base_sha256: digest,
            content_sha256: digest,
            content_ref: digest
          }
        ],
        record_revision: 999
      }
    });
    expect(patch.statusCode).toBe(400);
    expect(control.patchDraft).not.toHaveBeenCalled();

    const sourceEdit = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${draftId}/source-edits`,
      headers: { "if-match": etag },
      payload: {
        file: { root: "project", path: "agents/reviewer/agent.yaml" },
        operations: [
          {
            op: "set",
            path: [],
            value: "forbidden root replacement",
            base_sha256: digest
          }
        ]
      }
    });
    expect(sourceEdit.statusCode).toBe(400);
    expect(control.editDraftSource).not.toHaveBeenCalled();
    await server.close();
  });
});
