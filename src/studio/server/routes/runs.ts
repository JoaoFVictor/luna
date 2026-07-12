import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  RunCatalogItemSchema,
  RunCatalogPageSchema,
  RunDisplayStatusSchema,
  RunEventPageSchema
} from "../../contracts/runs.js";
import {
  StudioRunEventStreamCompleteSchema,
  StudioRunListQuerySchema,
  StudioRunParamsSchema,
  StudioRunTimelineQuerySchema
} from "../../contracts/run-api.js";
import type { StudioLocalPrincipal } from "../../contracts/control-api.js";
import type {
  RunCatalogListQuery,
  RunCatalogPort,
  RunEventLedgerPort,
  RunEventListQuery
} from "../../application/runs/ports.js";
import { runStoreError } from "../../application/runs/errors.js";
import {
  RunGraphReadError,
  type RunGraphService
} from "../../application/runs/graph-service.js";
import {
  RunNodeOutputReadError,
  type RunNodeOutputService
} from "../../application/runs/node-output-service.js";
import { RunGraphResponseSchema } from "../../contracts/run-graph.js";
import {
  RunNodeOutputComparisonResponseSchema,
  RunNodeOutputResponseSchema
} from "../../contracts/run-node-output.js";

const StatusFilterSchema = z
  .array(RunDisplayStatusSchema)
  .min(1)
  .max(16)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Run status filters must be unique"
      });
    }
  });
const EventTypeFilterSchema = z
  .array(
    z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9._-]*$/)
  )
  .min(1)
  .max(64)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Run event type filters must be unique"
      });
    }
  });
const RunEventStreamQuerySchema = z
  .object({
    after_sequence: z
      .string()
      .max(16)
      .regex(/^(0|[1-9]\d*)$/)
      .optional()
  })
  .strict();
const RunNodeOutputParamsSchema = z.object({
  runId: z.string().trim().min(1).max(256),
  nodeId: z.string().trim().min(1).max(256)
}).strict();
const RunNodeOutputComparisonQuerySchema = z.object({
  baseline_run_id: z.string().trim().min(1).max(256)
}).strict();
const MAX_ACTIVE_EVENT_STREAMS = 16;
const STREAM_PAGE_SIZE = 200;
const STREAM_POLL_INTERVAL_MS = 1_000;
const STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

function sequenceHeader(value: string | string[] | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^\d+$/.test(value)) {
    throw runStoreError("run_cursor_invalid", "The event stream cursor is invalid");
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw runStoreError("run_cursor_invalid", "The event stream cursor is invalid");
  }
  return sequence;
}

function terminalStatus(status: string): boolean {
  return [
    "rejected",
    "succeeded",
    "failed",
    "outcome_unknown",
    "timed_out",
    "cancelled"
  ].includes(status);
}

async function abortableDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function commaSeparated<T>(
  parseRequest: StudioRunRouteOptions["parseRequest"],
  schema: z.ZodType<T>,
  value: string
): T {
  return parseRequest(schema, value.split(","));
}

export type StudioRunControl = {
  readonly catalog: Pick<RunCatalogPort, "get" | "list">;
  readonly events: Pick<RunEventLedgerPort, "list">;
  readonly graph: Pick<RunGraphService, "get">;
  readonly outputs: Pick<RunNodeOutputService, "get" | "compare">;
};

export type StudioRunRouteOptions = {
  readonly apiPrefix: string;
  readonly control: StudioRunControl;
  readonly principalFor: (request: FastifyRequest) => StudioLocalPrincipal;
  readonly parseRequest: <T>(schema: z.ZodType<T>, value: unknown) => T;
};

function catalogQuery(
  query: z.infer<typeof StudioRunListQuerySchema>,
  parseRequest: StudioRunRouteOptions["parseRequest"]
): RunCatalogListQuery {
  return {
    filters: {
      ...(query.workflow_id === undefined
        ? {}
        : { workflow_id: query.workflow_id }),
      ...(query.status === undefined
        ? {}
        : {
            statuses: commaSeparated(
              parseRequest,
              StatusFilterSchema,
              query.status
            )
          }),
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.created_from === undefined
        ? {}
        : { created_from: query.created_from }),
      ...(query.created_to === undefined
        ? {}
        : { created_to: query.created_to }),
      ...(query.correlation_id === undefined
        ? {}
        : { correlation_id: query.correlation_id }),
      ...(query.job_id === undefined ? {} : { job_id: query.job_id }),
      ...(query.plan_id === undefined
        ? {}
        : { accepted_plan_id: query.plan_id })
    },
    direction: query.direction ?? "desc",
    limit: query.limit === undefined ? 50 : Number(query.limit),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor })
  };
}

function timelineQuery(
  runId: string,
  query: z.infer<typeof StudioRunTimelineQuerySchema>,
  parseRequest: StudioRunRouteOptions["parseRequest"]
): RunEventListQuery {
  return {
    run_id: runId,
    direction: query.direction ?? "asc",
    event_types:
      query.event_type === undefined
        ? []
        : commaSeparated(
            parseRequest,
            EventTypeFilterSchema,
            query.event_type
          ),
    limit: query.limit === undefined ? 50 : Number(query.limit),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor })
  };
}

function publicRunCatalogItem(
  item: z.infer<typeof RunCatalogItemSchema>
): z.infer<typeof RunCatalogItemSchema> {
  const { graph_snapshot_handle: _internalHandle, ...record } = item.record;
  return RunCatalogItemSchema.parse({ ...item, record });
}

export async function registerStudioRunRoutes(
  server: FastifyInstance,
  options: StudioRunRouteOptions
): Promise<void> {
  const base = `${options.apiPrefix}/runs`;
  let activeEventStreams = 0;

  server.get(base, async (request) => {
    options.principalFor(request);
    const query = options.parseRequest(
      StudioRunListQuerySchema,
      request.query
    );
    return RunCatalogPageSchema.parse(
      await options.control.catalog.list(
        catalogQuery(query, options.parseRequest)
      )
    );
  });

  server.get(`${base}/:runId`, async (request) => {
    options.principalFor(request);
    const { runId } = options.parseRequest(
      StudioRunParamsSchema,
      request.params
    );
    const item = await options.control.catalog.get(runId);
    if (item === undefined) {
      throw runStoreError("run_not_found", "The requested run does not exist");
    }
    return publicRunCatalogItem(RunCatalogItemSchema.parse(item));
  });

  server.get(`${base}/:runId/graph`, async (request) => {
    options.principalFor(request);
    const { runId } = options.parseRequest(
      StudioRunParamsSchema,
      request.params
    );
    try {
      return RunGraphResponseSchema.parse(
        await options.control.graph.get(runId)
      );
    } catch (cause) {
      if (
        cause instanceof RunGraphReadError &&
        cause.code === "run_graph_run_not_found"
      ) {
        throw runStoreError(
          "run_not_found",
          "The requested run does not exist"
        );
      }
      throw cause;
    }
  });

  server.get(`${base}/:runId/nodes/:nodeId/output`, async (request) => {
    options.principalFor(request);
    const { runId, nodeId } = options.parseRequest(
      RunNodeOutputParamsSchema,
      request.params
    );
    try {
      return RunNodeOutputResponseSchema.parse(
        await options.control.outputs.get(runId, nodeId)
      );
    } catch (cause) {
      if (
        (cause instanceof RunGraphReadError &&
          cause.code === "run_graph_run_not_found") ||
        cause instanceof RunNodeOutputReadError
      ) {
        throw runStoreError(
          "run_not_found",
          "The requested run node does not exist"
        );
      }
      throw cause;
    }
  });

  server.get(`${base}/:runId/nodes/:nodeId/output/compare`, async (request) => {
    options.principalFor(request);
    const { runId, nodeId } = options.parseRequest(
      RunNodeOutputParamsSchema,
      request.params
    );
    const { baseline_run_id: baselineRunId } = options.parseRequest(
      RunNodeOutputComparisonQuerySchema,
      request.query
    );
    try {
      return RunNodeOutputComparisonResponseSchema.parse(
        await options.control.outputs.compare(runId, nodeId, baselineRunId)
      );
    } catch (cause) {
      if (
        (cause instanceof RunGraphReadError &&
          cause.code === "run_graph_run_not_found") ||
        cause instanceof RunNodeOutputReadError
      ) {
        throw runStoreError(
          "run_not_found",
          "A requested run node does not exist"
        );
      }
      throw cause;
    }
  });

  server.get(`${base}/:runId/timeline`, async (request) => {
    options.principalFor(request);
    const { runId } = options.parseRequest(
      StudioRunParamsSchema,
      request.params
    );
    const query = options.parseRequest(
      StudioRunTimelineQuerySchema,
      request.query
    );
    return RunEventPageSchema.parse(
      await options.control.events.list(
        timelineQuery(runId, query, options.parseRequest)
      )
    );
  });

  server.get(`${base}/:runId/events/stream`, async (request, reply) => {
    options.principalFor(request);
    const { runId } = options.parseRequest(
      StudioRunParamsSchema,
      request.params
    );
    const query = options.parseRequest(
      RunEventStreamQuerySchema,
      request.query
    );
    const lastEventId = sequenceHeader(request.headers["last-event-id"]);
    const querySequence = sequenceHeader(query.after_sequence);
    if ((await options.control.catalog.get(runId)) === undefined) {
      throw runStoreError("run_not_found", "The requested run does not exist");
    }
    if (activeEventStreams >= MAX_ACTIVE_EVENT_STREAMS) {
      throw runStoreError("run_store_busy", "The Studio event stream limit was reached");
    }

    const controller = new AbortController();
    let released = false;
    const releaseStream = () => {
      if (released) return;
      released = true;
      activeEventStreams -= 1;
    };
    reply.raw.once("close", () => {
      controller.abort();
      releaseStream();
    });
    const initialSequence = Math.max(lastEventId ?? 0, querySequence ?? 0);
    activeEventStreams += 1;

    async function* stream(): AsyncGenerator<string> {
      let afterSequence = initialSequence;
      let lastHeartbeat = Date.now();
      try {
        yield "retry: 2000\n\n";
        while (!controller.signal.aborted) {
          const page = await options.control.events.list({
            run_id: runId,
            direction: "asc",
            event_types: [],
            limit: STREAM_PAGE_SIZE,
            after_sequence: afterSequence
          });
          for (const event of page.items) {
            if (controller.signal.aborted) return;
            afterSequence = event.sequence;
            yield `id: ${event.sequence}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`;
          }
          if (page.items.length === STREAM_PAGE_SIZE) {
            continue;
          }
          const run = await options.control.catalog.get(runId);
          if (run === undefined) return;
          if (
            terminalStatus(run.status) &&
            afterSequence >= page.as_of_sequence
          ) {
            const complete = StudioRunEventStreamCompleteSchema.parse({
              run_id: runId,
              status: run.status
            });
            yield `event: stream-complete\ndata: ${JSON.stringify(complete)}\n\n`;
            return;
          }
          const now = Date.now();
          if (now - lastHeartbeat >= STREAM_HEARTBEAT_INTERVAL_MS) {
            yield `: heartbeat ${now}\n\n`;
            lastHeartbeat = now;
          }
          await abortableDelay(controller.signal, STREAM_POLL_INTERVAL_MS);
        }
      } finally {
        releaseStream();
      }
    }

    reply
      .type("text/event-stream; charset=utf-8")
      .header("Cache-Control", "no-cache, no-transform")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no");
    return reply.send(Readable.from(stream()));
  });
}
