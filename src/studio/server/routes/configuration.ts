import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import type { z } from "zod";
import {
  StudioConfigurationApplyPlanSchema,
  StudioConfigurationApplyRequestSchema,
  StudioConfigurationApplyResultSchema,
  StudioConfigurationDraftParamsSchema,
  StudioConfigurationDraftSchema,
  StudioConfigurationEmptyCommandSchema,
  StudioConfigurationPatchRequestSchema,
  StudioConfigurationValidationResponseSchema,
  StudioConfigurationWorkflowParamsSchema,
  StudioModelConfigurationSchema,
  StudioProviderConfigurationSchema,
  StudioProviderProbeParamsSchema,
  StudioProviderProbeResultSchema,
  StudioRepositoryConfigurationSchema,
  StudioRuntimeConfigurationSchema,
  StudioWorkflowConfigurationSchema,
  type StudioConfigurationApplyPlan,
  type StudioConfigurationApplyResult,
  type StudioConfigurationDraft,
  type StudioConfigurationPatchRequest,
  type StudioConfigurationValidationResponse,
  type StudioModelConfiguration,
  type StudioProviderConfiguration,
  type StudioProviderProbeResult,
  type StudioRepositoryConfiguration,
  type StudioRuntimeConfiguration,
  type StudioWorkflowConfiguration
} from "../../contracts/configuration.js";
import type { StudioLocalPrincipal } from "../../contracts/control-api.js";
import { withStudioRequestAbort } from "../request-abort.js";

export type StudioConfigurationControl = {
  readonly getWorkflowConfiguration: (
    principal: StudioLocalPrincipal,
    workflowId: string
  ) => Promise<StudioWorkflowConfiguration>;
  readonly createWorkflowConfigurationDraft: (
    principal: StudioLocalPrincipal,
    workflowId: string
  ) => Promise<StudioConfigurationDraft>;
  readonly getWorkflowConfigurationDraft: (
    principal: StudioLocalPrincipal,
    workflowId: string,
    draftId: string
  ) => Promise<StudioConfigurationDraft>;
  readonly patchWorkflowConfigurationDraft: (
    principal: StudioLocalPrincipal,
    workflowId: string,
    draftId: string,
    input: StudioConfigurationPatchRequest,
    ifMatch: string | undefined
  ) => Promise<StudioConfigurationDraft>;
  readonly validateWorkflowConfigurationDraft: (
    principal: StudioLocalPrincipal,
    workflowId: string,
    draftId: string,
    ifMatch: string | undefined
  ) => Promise<StudioConfigurationValidationResponse>;
  readonly planWorkflowConfigurationApply: (
    principal: StudioLocalPrincipal,
    workflowId: string,
    draftId: string
  ) => Promise<StudioConfigurationApplyPlan>;
  readonly applyWorkflowConfigurationDraft: (
    principal: StudioLocalPrincipal,
    workflowId: string,
    draftId: string,
    input: {
      readonly planToken: string;
      readonly idempotencyKey: string;
      readonly ifMatch: string | undefined;
    }
  ) => Promise<StudioConfigurationApplyResult>;
  readonly models: (
    principal: StudioLocalPrincipal
  ) => Promise<StudioModelConfiguration>;
  readonly repositories: (
    principal: StudioLocalPrincipal
  ) => Promise<StudioRepositoryConfiguration>;
  readonly providers: (
    principal: StudioLocalPrincipal
  ) => Promise<StudioProviderConfiguration>;
  readonly testProviderConnection: (
    principal: StudioLocalPrincipal,
    providerId: string,
    signal?: AbortSignal
  ) => Promise<StudioProviderProbeResult>;
  readonly runtime: (
    principal: StudioLocalPrincipal
  ) => Promise<StudioRuntimeConfiguration>;
};

export type StudioConfigurationRouteOptions = {
  readonly apiPrefix: string;
  readonly control: StudioConfigurationControl;
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

function configurationDraft(
  reply: FastifyReply,
  draft: StudioConfigurationDraft
): StudioConfigurationDraft {
  reply.header("ETag", draft.etag);
  return StudioConfigurationDraftSchema.parse(draft);
}

export async function registerStudioConfigurationRoutes(
  server: FastifyInstance,
  options: StudioConfigurationRouteOptions
): Promise<void> {
  const base = `${options.apiPrefix}/configuration`;
  const workflows = `${base}/workflows`;

  server.get(`${workflows}/:workflowId`, async (request) => {
    const params = options.parseRequest(
      StudioConfigurationWorkflowParamsSchema,
      request.params
    );
    return StudioWorkflowConfigurationSchema.parse(
      await options.control.getWorkflowConfiguration(
        options.principalFor(request),
        params.workflowId
      )
    );
  });

  server.post(`${workflows}/:workflowId/drafts`, async (request, reply) => {
    const params = options.parseRequest(
      StudioConfigurationWorkflowParamsSchema,
      request.params
    );
    options.parseRequest(
      StudioConfigurationEmptyCommandSchema,
      request.body ?? {}
    );
    const draft = await options.control.createWorkflowConfigurationDraft(
      options.principalFor(request),
      params.workflowId
    );
    reply
      .code(201)
      .header(
        "Location",
        `${workflows}/${params.workflowId}/drafts/${draft.draft_id}`
      );
    return configurationDraft(reply, draft);
  });

  server.get(
    `${workflows}/:workflowId/drafts/:draftId`,
    async (request, reply) => {
      const params = options.parseRequest(
        StudioConfigurationDraftParamsSchema,
        request.params
      );
      return configurationDraft(
        reply,
        await options.control.getWorkflowConfigurationDraft(
          options.principalFor(request),
          params.workflowId,
          params.draftId
        )
      );
    }
  );

  server.patch(
    `${workflows}/:workflowId/drafts/:draftId`,
    async (request, reply) => {
      const params = options.parseRequest(
        StudioConfigurationDraftParamsSchema,
        request.params
      );
      const input = options.parseRequest(
        StudioConfigurationPatchRequestSchema,
        request.body
      );
      return configurationDraft(
        reply,
        await options.control.patchWorkflowConfigurationDraft(
          options.principalFor(request),
          params.workflowId,
          params.draftId,
          input,
          ifMatch(request)
        )
      );
    }
  );

  server.post(
    `${workflows}/:workflowId/drafts/:draftId/validate`,
    async (request, reply) => {
      const params = options.parseRequest(
        StudioConfigurationDraftParamsSchema,
        request.params
      );
      options.parseRequest(
        StudioConfigurationEmptyCommandSchema,
        request.body ?? {}
      );
      const result = StudioConfigurationValidationResponseSchema.parse(
        await options.control.validateWorkflowConfigurationDraft(
          options.principalFor(request),
          params.workflowId,
          params.draftId,
          ifMatch(request)
        )
      );
      reply.header("ETag", result.draft.etag);
      return result;
    }
  );

  server.post(
    `${workflows}/:workflowId/drafts/:draftId/plan-apply`,
    async (request) => {
      const params = options.parseRequest(
        StudioConfigurationDraftParamsSchema,
        request.params
      );
      options.parseRequest(
        StudioConfigurationEmptyCommandSchema,
        request.body ?? {}
      );
      return StudioConfigurationApplyPlanSchema.parse(
        await options.control.planWorkflowConfigurationApply(
          options.principalFor(request),
          params.workflowId,
          params.draftId
        )
      );
    }
  );

  server.post(
    `${workflows}/:workflowId/drafts/:draftId/apply`,
    async (request) => {
      const params = options.parseRequest(
        StudioConfigurationDraftParamsSchema,
        request.params
      );
      const input = options.parseRequest(
        StudioConfigurationApplyRequestSchema,
        request.body
      );
      return StudioConfigurationApplyResultSchema.parse(
        await options.control.applyWorkflowConfigurationDraft(
          options.principalFor(request),
          params.workflowId,
          params.draftId,
          {
            planToken: input.plan_token,
            idempotencyKey: input.idempotency_key,
            ifMatch: ifMatch(request)
          }
        )
      );
    }
  );

  server.get(`${base}/models`, async (request) =>
    StudioModelConfigurationSchema.parse(
      await options.control.models(options.principalFor(request))
    )
  );
  server.get(`${base}/repositories`, async (request) =>
    StudioRepositoryConfigurationSchema.parse(
      await options.control.repositories(options.principalFor(request))
    )
  );
  server.get(`${base}/providers`, async (request) =>
    StudioProviderConfigurationSchema.parse(
      await options.control.providers(options.principalFor(request))
    )
  );
  server.post(`${base}/providers/:providerId/probe`, async (request, reply) => {
    const params = options.parseRequest(
      StudioProviderProbeParamsSchema,
      request.params
    );
    options.parseRequest(StudioConfigurationEmptyCommandSchema, request.body ?? {});
    const result = await withStudioRequestAbort(request, reply, async (signal) =>
      StudioProviderProbeResultSchema.parse(
        await options.control.testProviderConnection(
          options.principalFor(request),
          params.providerId,
          signal
        )
      )
    );
    if (result.status === "unsupported") reply.code(404);
    return result;
  });
  server.get(`${base}/runtime`, async (request) =>
    StudioRuntimeConfigurationSchema.parse(
      await options.control.runtime(options.principalFor(request))
    )
  );
}
