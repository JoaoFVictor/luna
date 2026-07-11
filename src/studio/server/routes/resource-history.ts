import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { StudioLocalPrincipal } from "../../contracts/control-api.js";
import {
  StudioResourceHistoryCompareRequestSchema,
  StudioResourceHistoryCompareResponseSchema,
  StudioResourceHistoryListQuerySchema,
  StudioResourceHistoryParamsSchema,
  StudioResourceHistoryResponseSchema,
  StudioResourceHistoryRestoreRequestSchema,
  StudioResourceHistoryRestoreResponseSchema,
  type StudioHistoryResource,
  type StudioResourceHistoryCompareRequest,
  type StudioResourceHistoryCompareResponse,
  type StudioResourceHistoryListQuery,
  type StudioResourceHistoryResponse,
  type StudioResourceHistoryRestoreRequest,
  type StudioResourceHistoryRestoreResponse
} from "../../contracts/resource-history.js";

export type StudioResourceHistoryControl = {
  readonly listResourceHistory: (
    principal: StudioLocalPrincipal,
    resource: StudioHistoryResource,
    query: StudioResourceHistoryListQuery
  ) => Promise<StudioResourceHistoryResponse>;
  readonly compareResourceHistory: (
    principal: StudioLocalPrincipal,
    resource: StudioHistoryResource,
    request: StudioResourceHistoryCompareRequest
  ) => Promise<StudioResourceHistoryCompareResponse>;
  readonly restoreResourceHistory: (
    principal: StudioLocalPrincipal,
    resource: StudioHistoryResource,
    request: StudioResourceHistoryRestoreRequest
  ) => Promise<StudioResourceHistoryRestoreResponse>;
};

export type StudioResourceHistoryRouteOptions = {
  readonly apiPrefix: string;
  readonly control: StudioResourceHistoryControl;
  readonly principalFor: (request: FastifyRequest) => StudioLocalPrincipal;
  readonly parseRequest: <T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    value: unknown
  ) => T;
};

function resourceFrom(
  options: StudioResourceHistoryRouteOptions,
  request: FastifyRequest
): StudioHistoryResource {
  return options.parseRequest(StudioResourceHistoryParamsSchema, request.params);
}

function restoredDraft(
  reply: FastifyReply,
  result: StudioResourceHistoryRestoreResponse,
  draftsBase: string
): StudioResourceHistoryRestoreResponse {
  reply
    .code(201)
    .header("ETag", result.draft.etag)
    .header("Location", `${draftsBase}/${result.draft.draft_id}`);
  return StudioResourceHistoryRestoreResponseSchema.parse(result);
}

export async function registerStudioResourceHistoryRoutes(
  server: FastifyInstance,
  options: StudioResourceHistoryRouteOptions
): Promise<void> {
  const base = `${options.apiPrefix}/resources/:kind/:id/history`;

  server.get(base, async (request) => {
    const resource = resourceFrom(options, request);
    const query = options.parseRequest(
      StudioResourceHistoryListQuerySchema,
      request.query
    );
    return StudioResourceHistoryResponseSchema.parse(
      await options.control.listResourceHistory(
        options.principalFor(request),
        resource,
        query
      )
    );
  });

  server.get(`${base}/compare`, async (request) => {
    const resource = resourceFrom(options, request);
    const input = options.parseRequest(
      StudioResourceHistoryCompareRequestSchema,
      request.query
    );
    return StudioResourceHistoryCompareResponseSchema.parse(
      await options.control.compareResourceHistory(
        options.principalFor(request),
        resource,
        input
      )
    );
  });

  server.post(`${base}/restore`, async (request, reply) => {
    const resource = resourceFrom(options, request);
    const input = options.parseRequest(
      StudioResourceHistoryRestoreRequestSchema,
      request.body
    );
    return restoredDraft(
      reply,
      await options.control.restoreResourceHistory(
        options.principalFor(request),
        resource,
        input
      ),
      `${options.apiPrefix}/drafts`
    );
  });
}
