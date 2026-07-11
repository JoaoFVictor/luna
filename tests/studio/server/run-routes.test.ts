import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunCatalogItem } from "../../../src/studio/contracts/runs.js";
import { registerStudioRunRoutes } from "../../../src/studio/server/routes/runs.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const runItem: RunCatalogItem = {
  record: {
    schema_version: 1,
    record_revision: 1,
    run_id: "run-1",
    workflow_id: "code-review",
    workflow_revision: DIGEST,
    definition_bundle_hash: DIGEST,
    catalog_fingerprint: DIGEST,
    execution_snapshot_hash: DIGEST,
    dispatch_status: "queued",
    created_at: "2026-07-10T12:00:00.000Z",
    updated_at: "2026-07-10T12:00:00.000Z",
    active_node_ids: [],
    artifact_count: 0,
    interrupt_count: 0,
    side_effects: [],
    completeness: "complete"
  },
  status: "queued",
  wall_duration_ms: 0
};

const servers: ReturnType<typeof Fastify>[] = [];

async function routeFixture() {
  const server = Fastify({ logger: false });
  servers.push(server);
  const list = vi.fn(async () => ({
    items: [
      {
        run_id: "run-1",
        workflow_id: "code-review",
        workflow_revision: DIGEST,
        execution_snapshot_hash: DIGEST,
        dispatch_status: "queued" as const,
        status: "queued" as const,
        created_at: "2026-07-10T12:00:00.000Z",
        artifact_count: 0,
        interrupt_count: 0,
        completeness: "complete" as const,
        wall_duration_ms: 0
      }
    ],
    next_cursor: null,
    as_of: "2026-07-10T12:00:00.000Z"
  }));
  const get = vi.fn(async (runId: string) =>
    runId === "run-1" ? runItem : undefined
  );
  const events = vi.fn(async () => ({
    items: [
      {
        schema_version: 1 as const,
        run_id: "run-1",
        sequence: 1,
        event_id: "event-1",
        event_type: "run.allocated",
        occurred_at: "2026-07-10T12:00:00.000Z",
        record_revision: 1,
        data: {}
      }
    ],
    next_cursor: null,
    as_of_sequence: 1
  }));
  const principalFor = vi.fn(() => ({
    id: "local-user" as const,
    authentication: "local-session" as const
  }));
  server.setErrorHandler((error, _request, reply) => {
    const code = (error as { code?: string }).code;
    void reply
      .code(code === "run_not_found" ? 404 : 400)
      .send({ code: code ?? "invalid" });
  });
  await registerStudioRunRoutes(server, {
    apiPrefix: "/api/studio/v1",
    control: {
      catalog: { list, get },
      events: { list: events }
    },
    principalFor,
    parseRequest: (schema, value) => schema.parse(value)
  });
  return { server, list, get, events, principalFor };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

describe("Studio run routes", () => {
  it("maps bounded list filters into the backend-neutral catalog query", async () => {
    const { server, list, principalFor } = await routeFixture();
    const response = await server.inject({
      method: "GET",
      url:
        "/api/studio/v1/runs?workflow_id=code-review&status=queued,running" +
        "&source=github&direction=asc&limit=25"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0].run_id).toBe("run-1");
    expect(list).toHaveBeenCalledWith({
      filters: {
        workflow_id: "code-review",
        statuses: ["queued", "running"],
        source: "github"
      },
      direction: "asc",
      limit: 25
    });
    expect(principalFor).toHaveBeenCalledOnce();
  });

  it("returns a run detail and a filtered, cursored timeline", async () => {
    const { server, get, events } = await routeFixture();
    const detail = await server.inject({
      method: "GET",
      url: "/api/studio/v1/runs/run-1"
    });
    const timeline = await server.inject({
      method: "GET",
      url:
        "/api/studio/v1/runs/run-1/timeline" +
        "?event_type=run.allocated,node.started&direction=desc&limit=10&cursor=opaque"
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().record.run_id).toBe("run-1");
    expect(get).toHaveBeenCalledWith("run-1");
    expect(timeline.statusCode).toBe(200);
    expect(events).toHaveBeenCalledWith({
      run_id: "run-1",
      direction: "desc",
      event_types: ["run.allocated", "node.started"],
      limit: 10,
      cursor: "opaque"
    });
  });

  it("rejects duplicate filters and maps missing runs without querying internals", async () => {
    const { server, list } = await routeFixture();
    const invalid = await server.inject({
      method: "GET",
      url: "/api/studio/v1/runs?status=queued,queued"
    });
    const missing = await server.inject({
      method: "GET",
      url: "/api/studio/v1/runs/missing"
    });

    expect(invalid.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "run_not_found" });
  });
});
