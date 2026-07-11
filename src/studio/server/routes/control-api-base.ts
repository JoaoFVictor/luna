import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  StudioAgentCatalogSchema,
  type StudioAgentCatalog
} from "../../contracts/catalog.js";
import {
  StudioCapabilityCatalogSchema,
  type StudioCapabilityCatalog
} from "../../contracts/capability-catalog.js";
import {
  StudioCsrfRotationRequestSchema,
  StudioHealthResponseSchema,
  StudioSessionExchangeRequestSchema,
  StudioSessionStateResponseSchema,
  type StudioLocalPrincipal
} from "../../contracts/control-api.js";
import {
  StudioWorkflowCatalogSchema,
  type StudioWorkflowCatalog
} from "../../contracts/workflow-catalog.js";
import {
  parseStudioRequest,
  STUDIO_API_PREFIX,
  STUDIO_CSRF_ROTATION_PATH,
  STUDIO_HEALTH_PATH,
  STUDIO_SESSION_EXCHANGE_PATH,
  studioSessionRequest
} from "../control-api-boundary.js";
import type { StudioLocalSessionManager } from "../security/local-session.js";

export type StudioControlApiQueries = {
  readonly capabilities: (
    principal: StudioLocalPrincipal
  ) => Promise<StudioCapabilityCatalog> | StudioCapabilityCatalog;
  readonly agents: (
    principal: StudioLocalPrincipal
  ) => Promise<StudioAgentCatalog> | StudioAgentCatalog;
  readonly workflows: (
    principal: StudioLocalPrincipal
  ) => Promise<StudioWorkflowCatalog> | StudioWorkflowCatalog;
};

type StudioControlApiBaseRouteOptions = {
  readonly sessions: StudioLocalSessionManager;
  readonly queries: StudioControlApiQueries;
  readonly principalFor: (request: FastifyRequest) => StudioLocalPrincipal;
};

export function registerStudioControlApiBaseRoutes(
  server: FastifyInstance,
  options: StudioControlApiBaseRouteOptions
): void {
  server.get(STUDIO_HEALTH_PATH, async () =>
    StudioHealthResponseSchema.parse({ status: "ok" })
  );

  server.post(STUDIO_SESSION_EXCHANGE_PATH, async (request, reply) => {
    const body = parseStudioRequest(
      StudioSessionExchangeRequestSchema,
      request.body
    );
    const exchange = options.sessions.exchange(
      body.capability,
      studioSessionRequest(request)
    );
    reply.header("Set-Cookie", exchange.setCookie);
    return StudioSessionStateResponseSchema.parse({
      csrf_token: exchange.csrfToken,
      expires_at: exchange.expiresAt,
      principal: exchange.principal,
      mode: "local-single-user"
    });
  });

  server.post(STUDIO_CSRF_ROTATION_PATH, async (request) => {
    parseStudioRequest(StudioCsrfRotationRequestSchema, request.body);
    const rotation = options.sessions.recoverCsrf(
      studioSessionRequest(request)
    );
    return StudioSessionStateResponseSchema.parse({
      csrf_token: rotation.csrfToken,
      expires_at: rotation.expiresAt,
      principal: rotation.principal,
      mode: "local-single-user"
    });
  });

  server.get(`${STUDIO_API_PREFIX}/library`, async (request) =>
    StudioCapabilityCatalogSchema.parse(
      await options.queries.capabilities(options.principalFor(request))
    )
  );
  server.get(`${STUDIO_API_PREFIX}/agents`, async (request) =>
    StudioAgentCatalogSchema.parse(
      await options.queries.agents(options.principalFor(request))
    )
  );
  server.get(`${STUDIO_API_PREFIX}/workflows`, async (request) =>
    StudioWorkflowCatalogSchema.parse(
      await options.queries.workflows(options.principalFor(request))
    )
  );
}
