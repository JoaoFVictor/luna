import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { StudioLocalPrincipal } from "../../contracts/control-api.js";
import {
  RunLogListQuerySchema,
  RunLogPageSchema,
  StudioRunLogLevelSchema
} from "../../contracts/run-logs.js";
import { StudioRunParamsSchema } from "../../contracts/run-api.js";
import type { RunCatalogPort } from "../../application/runs/ports.js";
import { runStoreError } from "../../application/runs/errors.js";
import {
  RunLogReaderError,
  type RunLogReaderPort
} from "../../application/runs/log-ports.js";

const RunLogHttpQuerySchema = z
  .object({
    cursor: z.string().min(1).max(4_096).optional(),
    limit: z.coerce.number().int().safe().min(1).max(200).optional(),
    levels: z.string().max(128).optional(),
    node_id: z.string().trim().min(1).max(256).optional()
  })
  .strict();

export type StudioRunLogControl = {
  readonly reader: RunLogReaderPort;
  readonly catalog: Pick<RunCatalogPort, "get">;
};

export type StudioRunLogRouteOptions = {
  readonly apiPrefix: string;
  readonly control: StudioRunLogControl;
  readonly principalFor: (request: FastifyRequest) => StudioLocalPrincipal;
  readonly parseRequest: <T>(schema: z.ZodType<T>, value: unknown) => T;
};

function levelsFromHttp(
  raw: string | undefined,
  parseRequest: StudioRunLogRouteOptions["parseRequest"]
): readonly z.infer<typeof StudioRunLogLevelSchema>[] {
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  return parseRequest(
    z
      .array(StudioRunLogLevelSchema)
      .min(1)
      .max(4)
      .superRefine((levels, context) => {
        if (new Set(levels).size !== levels.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Run log levels must be unique"
          });
        }
      }),
    raw.split(",")
  );
}

export async function registerStudioRunLogRoutes(
  server: FastifyInstance,
  options: StudioRunLogRouteOptions
): Promise<void> {
  server.get(`${options.apiPrefix}/runs/:runId/logs`, async (request) => {
    options.principalFor(request);
    const { runId } = options.parseRequest(
      StudioRunParamsSchema,
      request.params
    );
    const query = options.parseRequest(RunLogHttpQuerySchema, request.query);
    if ((await options.control.catalog.get(runId)) === undefined) {
      throw runStoreError("run_not_found", "The requested run does not exist");
    }
    const canonicalQuery = RunLogListQuerySchema.safeParse({
      run_id: runId,
      levels: levelsFromHttp(query.levels, options.parseRequest),
      ...(query.node_id === undefined ? {} : { node_id: query.node_id }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor })
    });
    if (!canonicalQuery.success) {
      throw new RunLogReaderError(
        "run_log_input_invalid",
        "Run log query is invalid"
      );
    }
    return RunLogPageSchema.parse(
      await options.control.reader.list(canonicalQuery.data)
    );
  });
}
