import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  RunCatalogItemSchema,
  RunCatalogPageSchema,
  RunDisplayStatusSchema,
  RunEventPageSchema
} from "../../contracts/runs.js";
import {
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
      ...(query.job_id === undefined ? {} : { job_id: query.job_id })
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

export async function registerStudioRunRoutes(
  server: FastifyInstance,
  options: StudioRunRouteOptions
): Promise<void> {
  const base = `${options.apiPrefix}/runs`;

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
    return RunCatalogItemSchema.parse(item);
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
}
