import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import type { z } from "zod";
import {
  StudioApplyPlanResponseSchema,
  StudioApplyResultSchema,
  type StudioApplyPlanResponse,
  type StudioApplyResult
} from "../../contracts/apply.js";
import type { StudioLocalPrincipal } from "../../contracts/control-api.js";
import type { StudioPath } from "../../contracts/paths.js";
import {
  StudioDraftApplyRequestBodySchema,
  StudioDraftAuthoringListPageSchema,
  StudioDraftCreateRequestSchema,
  StudioDraftEmptyCommandSchema,
  StudioDraftItemSchema,
  StudioDraftListQuerySchema,
  StudioDraftParamsSchema,
  StudioDraftPatchRequestSchema,
  StudioDraftSourceEditRequestSchema,
  StudioDraftSourceViewQuerySchema,
  StudioDraftSourceViewSchema,
  StudioDraftTemplateCatalogSchema,
  StudioDraftValidationResponseSchema,
  type StudioDraftAuthoringListPage,
  type StudioDraftCreateRequest,
  type StudioDraftItem,
  type StudioDraftListQuery,
  type StudioDraftPatchRequest,
  type StudioDraftSourceEditRequest,
  type StudioDraftSourceView,
  type StudioDraftTemplateCatalog,
  type StudioDraftValidationResponse
} from "../../contracts/draft-authoring.js";

export type StudioDraftAuthoringControl = {
  readonly listDraftTemplates: (
    principal: StudioLocalPrincipal
  ) => Promise<StudioDraftTemplateCatalog> | StudioDraftTemplateCatalog;
  readonly createDraft: (
    principal: StudioLocalPrincipal,
    request: StudioDraftCreateRequest
  ) => Promise<StudioDraftItem>;
  readonly listDrafts: (
    principal: StudioLocalPrincipal,
    query: StudioDraftListQuery
  ) => Promise<StudioDraftAuthoringListPage>;
  readonly getDraft: (
    principal: StudioLocalPrincipal,
    draftId: string
  ) => Promise<StudioDraftItem>;
  readonly patchDraft: (
    principal: StudioLocalPrincipal,
    draftId: string,
    request: StudioDraftPatchRequest,
    ifMatch: string | undefined
  ) => Promise<StudioDraftItem>;
  readonly editDraftSource: (
    principal: StudioLocalPrincipal,
    draftId: string,
    request: StudioDraftSourceEditRequest,
    ifMatch: string | undefined
  ) => Promise<StudioDraftItem>;
  readonly getDraftSourceView: (
    principal: StudioLocalPrincipal,
    draftId: string,
    file: StudioPath
  ) => Promise<StudioDraftSourceView>;
  readonly deleteDraft: (
    principal: StudioLocalPrincipal,
    draftId: string,
    ifMatch: string | undefined
  ) => Promise<void>;
  readonly validateDraft: (
    principal: StudioLocalPrincipal,
    draftId: string,
    ifMatch: string | undefined
  ) => Promise<StudioDraftValidationResponse>;
  readonly compileDraft: (
    principal: StudioLocalPrincipal,
    draftId: string,
    ifMatch: string | undefined
  ) => Promise<StudioDraftValidationResponse>;
  readonly planDraftApply: (
    principal: StudioLocalPrincipal,
    draftId: string
  ) => Promise<StudioApplyPlanResponse>;
  readonly applyDraft: (
    principal: StudioLocalPrincipal,
    draftId: string,
    request: {
      readonly planToken: string;
      readonly idempotencyKey: string;
      readonly ifMatch: string | undefined;
    }
  ) => Promise<StudioApplyResult>;
};

export type StudioDraftAuthoringRouteOptions = {
  readonly apiPrefix: string;
  readonly control: StudioDraftAuthoringControl;
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

export async function registerStudioDraftAuthoringRoutes(
  server: FastifyInstance,
  options: StudioDraftAuthoringRouteOptions
): Promise<void> {
  const base = `${options.apiPrefix}/drafts`;

  server.get(`${options.apiPrefix}/draft-templates`, async (request) =>
    StudioDraftTemplateCatalogSchema.parse(
      await options.control.listDraftTemplates(options.principalFor(request))
    )
  );

  server.post(base, async (request, reply) => {
    const body = options.parseRequest(
      StudioDraftCreateRequestSchema,
      request.body
    );
    const item = await options.control.createDraft(
      options.principalFor(request),
      body
    );
    reply
      .code(201)
      .header("Location", `${base}/${item.draft_id}`);
    return withEtag(reply, item);
});
  server.get(base, async (request) => {
    const query = options.parseRequest(
      StudioDraftListQuerySchema,
      request.query
    );
    return StudioDraftAuthoringListPageSchema.parse(
      await options.control.listDrafts(
        options.principalFor(request),
        query
      )
    );
  });

  server.get(`${base}/:draftId`, async (request, reply) => {
    const params = options.parseRequest(
      StudioDraftParamsSchema,
      request.params
    );
    const item = await options.control.getDraft(
      options.principalFor(request),
      params.draftId
    );
    return withEtag(reply, item);
  });

  server.get(`${base}/:draftId/source-view`, async (request) => {
    const params = options.parseRequest(
      StudioDraftParamsSchema,
      request.params
    );
    const query = options.parseRequest(
      StudioDraftSourceViewQuerySchema,
      request.query
    );
    return StudioDraftSourceViewSchema.parse(
      await options.control.getDraftSourceView(
        options.principalFor(request),
        params.draftId,
        query
      )
    );
  });

  server.patch(`${base}/:draftId`, async (request, reply) => {
    const params = options.parseRequest(
      StudioDraftParamsSchema,
      request.params
    );
    const body = options.parseRequest(
      StudioDraftPatchRequestSchema,
      request.body
    );
    const item = await options.control.patchDraft(
      options.principalFor(request),
      params.draftId,
      body,
      ifMatch(request)
    );
    return withEtag(reply, item);
  });

  server.post(`${base}/:draftId/source-edits`, async (request, reply) => {
    const params = options.parseRequest(
      StudioDraftParamsSchema,
      request.params
    );
    const body = options.parseRequest(
      StudioDraftSourceEditRequestSchema,
      request.body
    );
    const item = await options.control.editDraftSource(
      options.principalFor(request),
      params.draftId,
      body,
      ifMatch(request)
    );
    return withEtag(reply, item);
  });

  server.delete(`${base}/:draftId`, async (request, reply) => {
    const params = options.parseRequest(
      StudioDraftParamsSchema,
      request.params
    );
    await options.control.deleteDraft(
      options.principalFor(request),
      params.draftId,
      ifMatch(request)
    );
    return await reply.code(204).send();
  });

  server.post(`${base}/:draftId/validate`, async (request, reply) => {
    const params = options.parseRequest(
      StudioDraftParamsSchema,
      request.params
    );
    options.parseRequest(
      StudioDraftEmptyCommandSchema,
      request.body ?? {}
    );
    const result = StudioDraftValidationResponseSchema.parse(
      await options.control.validateDraft(
        options.principalFor(request),
        params.draftId,
        ifMatch(request)
      )
    );
    reply.header("ETag", result.draft.etag);
    return result;
  });

  server.post(`${base}/:draftId/compile`, async (request, reply) => {
    const params = options.parseRequest(
      StudioDraftParamsSchema,
      request.params
    );
    options.parseRequest(
      StudioDraftEmptyCommandSchema,
      request.body ?? {}
    );
    const result = StudioDraftValidationResponseSchema.parse(
      await options.control.compileDraft(
        options.principalFor(request),
        params.draftId,
        ifMatch(request)
      )
    );
    reply.header("ETag", result.draft.etag);
    return result;
  });

  server.post(`${base}/:draftId/plan-apply`, async (request) => {
    const params = options.parseRequest(
      StudioDraftParamsSchema,
      request.params
    );
    options.parseRequest(
      StudioDraftEmptyCommandSchema,
      request.body ?? {}
    );
    return StudioApplyPlanResponseSchema.parse(
      await options.control.planDraftApply(
        options.principalFor(request),
        params.draftId
      )
    );
  });

  server.post(`${base}/:draftId/apply`, async (request, reply) => {
    const params = options.parseRequest(
      StudioDraftParamsSchema,
      request.params
    );
    const body = options.parseRequest(
      StudioDraftApplyRequestBodySchema,
      request.body
    );
    const etag = ifMatch(request);
    const result = StudioApplyResultSchema.parse(
      await options.control.applyDraft(
        options.principalFor(request),
        params.draftId,
        {
          planToken: body.plan_token,
          idempotencyKey: body.idempotency_key,
          ifMatch: etag
        }
      )
    );
    if (etag !== undefined) {
      reply.header("ETag", etag);
    }
    return result;
  });
}
