import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioDraftItem } from "../../../src/studio/contracts/draft-authoring.js";
import { registerStudioRunOutputFixtureRoutes } from "../../../src/studio/server/routes/run-output-fixtures.js";

const DRAFT_ID = "15956bef-49cb-4c8b-acc2-bd189fb9d3b3";
const DIGEST = `sha256:${"a".repeat(64)}`;
const ETAG = `"studio-draft:${DRAFT_ID}:3:${DIGEST}"`;
const servers: ReturnType<typeof Fastify>[] = [];

function draft(): StudioDraftItem {
  return {
    draft_id: DRAFT_ID,
    record_revision: 3,
    content_revision: 1,
    layout_revision: 2,
    primary_resource: { kind: "workflow", id: "code-review" },
    status: "valid",
    draft_hash: DIGEST,
    etag: ETAG,
    files: [],
    layout: {},
    created_at: "2026-07-11T09:00:00.000Z",
    updated_at: "2026-07-11T09:02:00.000Z"
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

describe("Studio run output fixture route", () => {
  it("forwards the authenticated, hash-bound command and returns the new ETag", async () => {
    const server = Fastify({ logger: false });
    servers.push(server);
    const promoteRunOutputFixture = vi.fn(async () => draft());
    const editRunOutputFixture = vi.fn(async () => draft());
    const despinRunOutputFixture = vi.fn(async () => draft());
    const principal = {
      id: "local-user" as const,
      authentication: "local-session" as const
    };
    await registerStudioRunOutputFixtureRoutes(server, {
      apiPrefix: "/api/studio/v1",
      control: {
        promoteRunOutputFixture,
        editRunOutputFixture,
        despinRunOutputFixture
      },
      principalFor: () => principal,
      parseRequest: (schema, value) => schema.parse(value)
    });

    const body = {
      fixture_name: "approved-review",
      run_id: "run-1",
      node_id: "review",
      graph_hash: DIGEST,
      outcome_hash: DIGEST
    };
    const response = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${DRAFT_ID}/expression-fixtures/from-run-output`,
      headers: { "if-match": ETAG },
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe(ETAG);
    expect(response.json().draft_id).toBe(DRAFT_ID);
    expect(promoteRunOutputFixture).toHaveBeenCalledWith(
      principal,
      DRAFT_ID,
      body,
      ETAG
    );
  });

  it("forwards server-authoritative edit and despin commands with If-Match", async () => {
    const server = Fastify({ logger: false });
    servers.push(server);
    const principal = {
      id: "local-user" as const,
      authentication: "local-session" as const
    };
    const editRunOutputFixture = vi.fn(async () => draft());
    const despinRunOutputFixture = vi.fn(async () => draft());
    await registerStudioRunOutputFixtureRoutes(server, {
      apiPrefix: "/api/studio/v1",
      control: {
        promoteRunOutputFixture: vi.fn(async () => draft()),
        editRunOutputFixture,
        despinRunOutputFixture
      },
      principalFor: () => principal,
      parseRequest: (schema, value) => schema.parse(value)
    });

    const edit = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${DRAFT_ID}/expression-fixtures/edit-run-output`,
      headers: { "if-match": ETAG },
      payload: { fixture_name: "approved-review", output: { summary: "edited" } }
    });
    const despin = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${DRAFT_ID}/expression-fixtures/despin-run-output`,
      headers: { "if-match": ETAG },
      payload: { fixture_name: "approved-review" }
    });

    expect(edit.statusCode).toBe(200);
    expect(despin.statusCode).toBe(200);
    expect(editRunOutputFixture).toHaveBeenCalledWith(
      principal,
      DRAFT_ID,
      { fixture_name: "approved-review", output: { summary: "edited" } },
      ETAG
    );
    expect(despinRunOutputFixture).toHaveBeenCalledWith(
      principal,
      DRAFT_ID,
      { fixture_name: "approved-review" },
      ETAG
    );
  });

  it("rejects unsafe fixture names before invoking the control", async () => {
    const server = Fastify({ logger: false });
    servers.push(server);
    const promoteRunOutputFixture = vi.fn(async () => draft());
    const editRunOutputFixture = vi.fn(async () => draft());
    const despinRunOutputFixture = vi.fn(async () => draft());
    server.setErrorHandler((_error, _request, reply) => {
      void reply.code(400).send({ code: "invalid_request" });
    });
    await registerStudioRunOutputFixtureRoutes(server, {
      apiPrefix: "/api/studio/v1",
      control: {
        promoteRunOutputFixture,
        editRunOutputFixture,
        despinRunOutputFixture
      },
      principalFor: () => ({
        id: "local-user" as const,
        authentication: "local-session" as const
      }),
      parseRequest: (schema, value) => schema.parse(value)
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${DRAFT_ID}/expression-fixtures/from-run-output`,
      headers: { "if-match": ETAG },
      payload: {
        fixture_name: "../unsafe",
        run_id: "run-1",
        node_id: "review",
        graph_hash: DIGEST,
        outcome_hash: DIGEST
      }
    });

    expect(response.statusCode).toBe(400);
    expect(promoteRunOutputFixture).not.toHaveBeenCalled();
  });
});
