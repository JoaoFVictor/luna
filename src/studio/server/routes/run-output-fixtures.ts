import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import type { z } from "zod";
import {
  StudioDraftItemSchema,
  StudioDraftParamsSchema,
  type StudioDraftItem
} from "../../contracts/draft-authoring.js";
import type { StudioLocalPrincipal } from "../../contracts/control-api.js";
import {
  DespinRunNodeOutputFixtureRequestSchema,
  EditRunNodeOutputFixtureRequestSchema,
  PromoteRunNodeOutputFixtureRequestSchema,
  type DespinRunNodeOutputFixtureRequest,
  type EditRunNodeOutputFixtureRequest,
  type PromoteRunNodeOutputFixtureRequest
} from "../../contracts/workflow-expression-fixtures.js";

export type StudioRunOutputFixtureControl = {
  readonly promoteRunOutputFixture: (
    principal: StudioLocalPrincipal,
    draftId: string,
    request: PromoteRunNodeOutputFixtureRequest,
    ifMatch: string | undefined
  ) => Promise<StudioDraftItem>;
  readonly editRunOutputFixture: (
    principal: StudioLocalPrincipal,
    draftId: string,
    request: EditRunNodeOutputFixtureRequest,
    ifMatch: string | undefined
  ) => Promise<StudioDraftItem>;
  readonly despinRunOutputFixture: (
    principal: StudioLocalPrincipal,
    draftId: string,
    request: DespinRunNodeOutputFixtureRequest,
    ifMatch: string | undefined
  ) => Promise<StudioDraftItem>;
};

export type StudioRunOutputFixtureRouteOptions = {
  readonly apiPrefix: string;
  readonly control: StudioRunOutputFixtureControl;
  readonly principalFor: (request: FastifyRequest) => StudioLocalPrincipal;
  readonly parseRequest: <T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    value: unknown
  ) => T;
};

function ifMatch(request: FastifyRequest): string | undefined {
  const header = request.headers["if-match"];
  return typeof header === "string" ? header : undefined;
}

function withEtag(reply: FastifyReply, item: StudioDraftItem): StudioDraftItem {
  reply.header("ETag", item.etag);
  return StudioDraftItemSchema.parse(item);
}

export async function registerStudioRunOutputFixtureRoutes(
  server: FastifyInstance,
  options: StudioRunOutputFixtureRouteOptions
): Promise<void> {
  server.post(
    `${options.apiPrefix}/drafts/:draftId/expression-fixtures/from-run-output`,
    async (request, reply) => {
      const params = options.parseRequest(
        StudioDraftParamsSchema,
        request.params
      );
      const body = options.parseRequest(
        PromoteRunNodeOutputFixtureRequestSchema,
        request.body
      );
      const item = await options.control.promoteRunOutputFixture(
        options.principalFor(request),
        params.draftId,
        body,
        ifMatch(request)
      );
      return withEtag(reply, item);
    }
  );
  server.post(
    `${options.apiPrefix}/drafts/:draftId/expression-fixtures/edit-run-output`,
    async (request, reply) => {
      const params = options.parseRequest(StudioDraftParamsSchema, request.params);
      const body = options.parseRequest(EditRunNodeOutputFixtureRequestSchema, request.body);
      const item = await options.control.editRunOutputFixture(
        options.principalFor(request),
        params.draftId,
        body,
        ifMatch(request)
      );
      return withEtag(reply, item);
    }
  );
  server.post(
    `${options.apiPrefix}/drafts/:draftId/expression-fixtures/despin-run-output`,
    async (request, reply) => {
      const params = options.parseRequest(StudioDraftParamsSchema, request.params);
      const body = options.parseRequest(DespinRunNodeOutputFixtureRequestSchema, request.body);
      const item = await options.control.despinRunOutputFixture(
        options.principalFor(request),
        params.draftId,
        body,
        ifMatch(request)
      );
      return withEtag(reply, item);
    }
  );
}
