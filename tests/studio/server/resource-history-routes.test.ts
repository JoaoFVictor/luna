import Fastify from "fastify";
import type { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { StudioLocalPrincipal } from "../../../src/studio/contracts/control-api.js";
import type { StudioDraftItem } from "../../../src/studio/contracts/draft-authoring.js";
import {
  registerStudioResourceHistoryRoutes,
  type StudioResourceHistoryControl
} from "../../../src/studio/server/routes/resource-history.js";

const BASE_REVISION = "a".repeat(40);
const TARGET_REVISION = "b".repeat(40);
const DRAFT_ID = "5bbc0ae8-d9f1-4cc2-b704-8186c026ad38";
const DIGEST = `sha256:${"c".repeat(64)}`;
const ETAG = `"studio-draft:${DRAFT_ID}:1:${DIGEST}"`;
const TIMESTAMP = "2026-07-11T12:00:00.000Z";
const RESOURCE = { kind: "agent", id: "reviewer" } as const;
const PRINCIPAL: StudioLocalPrincipal = {
  id: "local-user",
  authentication: "local-session"
};

function draftItem(): StudioDraftItem {
  return {
    draft_id: DRAFT_ID,
    record_revision: 1,
    content_revision: 1,
    layout_revision: 0,
    primary_resource: RESOURCE,
    status: "dirty",
    draft_hash: DIGEST,
    etag: ETAG,
    files: [],
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP
  };
}

function controlFixture(): StudioResourceHistoryControl & {
  [K in keyof StudioResourceHistoryControl]: ReturnType<typeof vi.fn>;
} {
  return {
    listResourceHistory: vi.fn(async () => ({
      resource: RESOURCE,
      revisions: [
        {
          revision_id: TARGET_REVISION,
          committed_at: TIMESTAMP,
          subject: "Update reviewer"
        },
        {
          revision_id: BASE_REVISION,
          committed_at: "2026-07-10T12:00:00.000Z",
          subject: "Create reviewer"
        }
      ],
      truncated: false
    })),
    compareResourceHistory: vi.fn(async () => ({
      resource: RESOURCE,
      base_revision_id: BASE_REVISION,
      target_revision_id: TARGET_REVISION,
      diff: [
        {
          file: {
            root: "project" as const,
            path: "agents/reviewer/agent.yaml"
          },
          kind: "modified" as const,
          before_sha256: DIGEST,
          after_sha256: `sha256:${"d".repeat(64)}`,
          before_mode: 0o644,
          after_mode: 0o644,
          textual_diff: "@@ -1 +1 @@\n-[REDACTED]\n+[REDACTED]\n",
          textual_diff_truncated: false,
          redacted: true as const
        }
      ]
    })),
    restoreResourceHistory: vi.fn(async () => ({
      resource: RESOURCE,
      revision_id: TARGET_REVISION,
      draft: draftItem()
    }))
  };
}

function parseRequest<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown
): T {
  return schema.parse(value);
}

async function serverFor(control: StudioResourceHistoryControl) {
  const server = Fastify({ logger: false });
  server.setErrorHandler((_error, _request, reply) => {
    void reply.code(400).send({ error: "invalid request" });
  });
  await registerStudioResourceHistoryRoutes(server, {
    apiPrefix: "/api/studio/v1",
    control,
    principalFor: () => PRINCIPAL,
    parseRequest
  });
  return server;
}

describe("Studio resource history routes", () => {
  it("lists and compares only the requested workflow or agent history", async () => {
    const control = controlFixture();
    const server = await serverFor(control);

    const listed = await server.inject({
      method: "GET",
      url: "/api/studio/v1/resources/agent/reviewer/history?limit=10"
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ resource: RESOURCE });
    expect(listed.json<{ revisions: { revision_id: string }[] }>().revisions)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ revision_id: TARGET_REVISION })
        ])
      );
    expect(control.listResourceHistory).toHaveBeenCalledWith(
      PRINCIPAL,
      RESOURCE,
      { limit: 10 }
    );

    const compared = await server.inject({
      method: "GET",
      url:
        "/api/studio/v1/resources/agent/reviewer/history/compare" +
        `?base_revision_id=${BASE_REVISION}&target_revision_id=${TARGET_REVISION}`
    });
    expect(compared.statusCode).toBe(200);
    expect(compared.json()).toMatchObject({
      base_revision_id: BASE_REVISION,
      target_revision_id: TARGET_REVISION,
      diff: [{ redacted: true }]
    });
    expect(control.compareResourceHistory).toHaveBeenCalledWith(
      PRINCIPAL,
      RESOURCE,
      {
        base_revision_id: BASE_REVISION,
        target_revision_id: TARGET_REVISION
      }
    );
    await server.close();
  });

  it("creates a normal draft only after literal restore confirmation", async () => {
    const control = controlFixture();
    const server = await serverFor(control);
    const restored = await server.inject({
      method: "POST",
      url: "/api/studio/v1/resources/agent/reviewer/history/restore",
      payload: {
        revision_id: TARGET_REVISION,
        confirm_restore_as_new_draft: true
      }
    });

    expect(restored.statusCode).toBe(201);
    expect(restored.headers.etag).toBe(ETAG);
    expect(restored.headers.location).toBe(
      `/api/studio/v1/drafts/${DRAFT_ID}`
    );
    expect(restored.json()).toMatchObject({
      resource: RESOURCE,
      revision_id: TARGET_REVISION,
      draft: { draft_id: DRAFT_ID, etag: ETAG }
    });
    expect(control.restoreResourceHistory).toHaveBeenCalledWith(
      PRINCIPAL,
      RESOURCE,
      {
        revision_id: TARGET_REVISION,
        confirm_restore_as_new_draft: true
      }
    );
    await server.close();
  });

  it("rejects revspecs, unsupported kinds, extra fields, and weak confirmation", async () => {
    const control = controlFixture();
    const server = await serverFor(control);
    const [revspec, unsupportedKind, extraField, weakConfirmation] =
      await Promise.all([
        server.inject({
          method: "GET",
          url:
            "/api/studio/v1/resources/agent/reviewer/history/compare" +
            `?base_revision_id=HEAD~1&target_revision_id=${TARGET_REVISION}`
        }),
        server.inject({
          method: "GET",
          url: "/api/studio/v1/resources/provider/github/history"
        }),
        server.inject({
          method: "POST",
          url: "/api/studio/v1/resources/agent/reviewer/history/restore",
          payload: {
            revision_id: TARGET_REVISION,
            confirm_restore_as_new_draft: true,
            apply_immediately: true
          }
        }),
        server.inject({
          method: "POST",
          url: "/api/studio/v1/resources/agent/reviewer/history/restore",
          payload: {
            revision_id: TARGET_REVISION,
            confirm_restore_as_new_draft: false
          }
        })
      ]);

    expect(revspec.statusCode).toBe(400);
    expect(unsupportedKind.statusCode).toBe(400);
    expect(extraField.statusCode).toBe(400);
    expect(weakConfirmation.statusCode).toBe(400);
    expect(control.compareResourceHistory).not.toHaveBeenCalled();
    expect(control.restoreResourceHistory).not.toHaveBeenCalled();
    await server.close();
  });
});
