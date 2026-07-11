import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunEventListQuery } from "../../../src/studio/application/runs/ports.js";
import { RunGraphReadError } from "../../../src/studio/application/runs/graph-service.js";
import type { RunCatalogItem } from "../../../src/studio/contracts/runs.js";
import { registerStudioRunRoutes } from "../../../src/studio/server/routes/runs.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PLAN_ID = `rp_${"p".repeat(32)}`;
const runItem: RunCatalogItem = {
  record: {
    schema_version: 1,
    record_revision: 1,
    run_id: "run-1",
    accepted_plan_id: PLAN_ID,
    input_provenance: {
      kind: "adapter",
      adapter_id: "github.pull-request",
      adapter_input_hash: DIGEST
    },
    workflow_id: "code-review",
    workflow_revision: DIGEST,
    definition_bundle_hash: DIGEST,
    catalog_fingerprint: DIGEST,
    execution_snapshot_hash: DIGEST,
    graph_snapshot_handle: `gs_${"A".repeat(32)}`,
    dispatch_status: "queued",
    created_at: "2026-07-10T12:00:00.000Z",
    updated_at: "2026-07-10T12:00:00.000Z",
    active_node_ids: [],
    artifact_count: 0,
    interrupt_count: 0,
    side_effects: [],
    lifecycle_projection: "exact",
    completeness: "complete"
  },
  status: "queued",
  wall_duration_ms: 0
};
const terminalRunItem: RunCatalogItem = {
  record: {
    ...runItem.record,
    record_revision: 3,
    dispatch_status: "started",
    run_status: "succeeded",
    updated_at: "2026-07-10T12:00:02.000Z",
    started_at: "2026-07-10T12:00:01.000Z",
    finished_at: "2026-07-10T12:00:02.000Z",
    owner_id: "worker-1",
    owner_claimed_at: "2026-07-10T12:00:00.500Z",
    heartbeat_at: "2026-07-10T12:00:02.000Z"
  },
  status: "succeeded",
  wall_duration_ms: 1_000
};

const servers: ReturnType<typeof Fastify>[] = [];

async function routeFixture(options: { terminal?: boolean } = {}) {
  const server = Fastify({ logger: false });
  servers.push(server);
  const list = vi.fn(async () => ({
    items: [
      {
        run_id: "run-1",
        accepted_plan_id: PLAN_ID,
        input_provenance: {
          kind: "adapter" as const,
          adapter_id: "github.pull-request",
          adapter_input_hash: DIGEST
        },
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
    runId === "run-1"
      ? options.terminal === true
        ? terminalRunItem
        : runItem
      : undefined
  );
  const event = {
    schema_version: 1 as const,
    run_id: "run-1",
    sequence: 1,
    event_id: "event-1",
    event_type: "run.allocated",
    occurred_at: "2026-07-10T12:00:00.000Z",
    record_revision: 1,
    data: {}
  };
  const events = vi.fn(async (query: RunEventListQuery) => ({
    items:
      query.after_sequence !== undefined && query.after_sequence >= event.sequence
        ? []
        : [event],
    next_cursor: null,
    as_of_sequence: 1
  }));
  const graph = vi.fn(async (runId: string) => {
    if (runId !== "run-1") {
      throw new RunGraphReadError(
        "run_graph_run_not_found",
        "Run was not found"
      );
    }
    return {
      schema_version: 1 as const,
      availability: "available" as const,
      run: {
        run_id: "run-1",
        workflow_id: "code-review",
        workflow_revision: DIGEST,
        definition_bundle_hash: DIGEST,
        execution_snapshot_hash: DIGEST,
        status: "queued" as const,
        completeness: "complete" as const
      },
      graph_hash: DIGEST,
      graph: {
        state_schema_version: "1",
        nodes: [
          {
            id: "context",
            kind: "built_in" as const,
            capability_id: "context.collect_context",
            can_create_pending_interrupt: false
          }
        ],
        edges: []
      },
      overlay: {
        observation: "unobservable" as const,
        reason: "run_not_started" as const
      }
    };
  });
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
      events: { list: events },
      graph: { get: graph }
    },
    principalFor,
    parseRequest: (schema, value) => schema.parse(value)
  });
  return { server, list, get, events, graph, principalFor };
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
        `&source=github&plan_id=${PLAN_ID}&direction=asc&limit=25`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0].run_id).toBe("run-1");
    expect(list).toHaveBeenCalledWith({
      filters: {
        workflow_id: "code-review",
        statuses: ["queued", "running"],
        source: "github",
        accepted_plan_id: PLAN_ID
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
    expect(detail.json().record).toMatchObject({
      accepted_plan_id: PLAN_ID,
      input_provenance: { adapter_id: "github.pull-request" }
    });
    expect(detail.body).not.toContain("graph_snapshot_handle");
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

  it("returns the strict immutable graph projection without internal handles", async () => {
    const { server, graph, principalFor } = await routeFixture();
    const response = await server.inject({
      method: "GET",
      url: "/api/studio/v1/runs/run-1/graph"
    });

    expect(response.statusCode).toBe(200);
    expect(graph).toHaveBeenCalledWith("run-1");
    expect(principalFor).toHaveBeenCalledOnce();
    expect(response.json()).toMatchObject({
      availability: "available",
      graph: {
        nodes: [{ id: "context" }]
      },
      overlay: {
        observation: "unobservable",
        reason: "run_not_started"
      }
    });
    expect(response.body).not.toContain("graph_snapshot_handle");
    expect(response.body).not.toContain("yaml_path");
    expect(response.body).not.toContain("config");
    expect(response.body).not.toContain("output");
  });

  it("rejects duplicate filters and maps missing runs without querying internals", async () => {
    const { server, list } = await routeFixture();
    const invalid = await server.inject({
      method: "GET",
      url: "/api/studio/v1/runs?status=queued,queued"
    });
    const invalidPlan = await server.inject({
      method: "GET",
      url: "/api/studio/v1/runs?plan_id=rp_short"
    });
    const missing = await server.inject({
      method: "GET",
      url: "/api/studio/v1/runs/missing"
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalidPlan.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "run_not_found" });
  });

  it("streams ordered events and resumes exclusively from Last-Event-ID", async () => {
    const { server, events } = await routeFixture({ terminal: true });
    const initial = await server.inject({
      method: "GET",
      url: "/api/studio/v1/runs/run-1/events/stream?after_sequence=0"
    });
    const resumed = await server.inject({
      method: "GET",
      url: "/api/studio/v1/runs/run-1/events/stream",
      headers: { "last-event-id": "1" }
    });

    expect(initial.statusCode).toBe(200);
    expect(initial.headers["content-type"]).toContain("text/event-stream");
    expect(initial.headers["x-accel-buffering"]).toBe("no");
    expect(initial.body).toContain("retry: 2000\n\n");
    expect(initial.body).toContain("id: 1\nevent: run-event\n");
    expect(initial.body).toContain('"event_id":"event-1"');
    expect(initial.body).toContain("event: stream-complete\n");

    expect(resumed.statusCode).toBe(200);
    expect(resumed.body).not.toContain("event: run-event");
    expect(resumed.body).toContain("event: stream-complete\n");
    expect(events).toHaveBeenLastCalledWith({
      run_id: "run-1",
      direction: "asc",
      event_types: [],
      limit: 200,
      after_sequence: 1
    });
  });

  it("resumes from the greatest validated EventSource cursor", async () => {
    const { server, events } = await routeFixture({ terminal: true });
    const response = await server.inject({
      method: "GET",
      url: "/api/studio/v1/runs/run-1/events/stream?after_sequence=1",
      headers: { "last-event-id": "3" }
    });

    expect(response.statusCode).toBe(200);
    expect(events).toHaveBeenCalledWith({
      run_id: "run-1",
      direction: "asc",
      event_types: [],
      limit: 200,
      after_sequence: 3
    });
  });

  it("rejects non-canonical stream cursors before reading events", async () => {
    const { server, events } = await routeFixture({ terminal: true });
    const nonCanonical = await server.inject({
      method: "GET",
      url: "/api/studio/v1/runs/run-1/events/stream?after_sequence=01"
    });

    expect(nonCanonical.statusCode).toBe(400);
    expect(events).not.toHaveBeenCalled();
  });
});
