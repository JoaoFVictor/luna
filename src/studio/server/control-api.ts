import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";
import {
  StudioAgentCatalogSchema,
  type StudioAgentCatalog
} from "../contracts/catalog.js";
import {
  StudioCapabilityCatalogSchema,
  type StudioCapabilityCatalog
} from "../contracts/capability-catalog.js";
import {
  StudioCsrfRotationRequestSchema,
  StudioHealthResponseSchema,
  StudioHttpErrorEnvelopeSchema,
  StudioSessionExchangeRequestSchema,
  StudioSessionStateResponseSchema,
  type StudioHttpErrorEnvelope,
  type StudioLocalPrincipal
} from "../contracts/control-api.js";
import {
  StudioWorkflowCatalogSchema,
  type StudioWorkflowCatalog
} from "../contracts/workflow-catalog.js";
import {
  StudioLocalSessionManager,
  StudioSessionError,
  type StudioSessionRequest
} from "./security/local-session.js";
import {
  registerStudioInputRoutingRoutes,
  type StudioInputRoutingControl
} from "./routes/input-routing.js";
import { studioDomainHttpError } from "./domain-error.js";

const API_PREFIX = "/api/studio/v1";
const SESSION_EXCHANGE_PATH = `${API_PREFIX}/session/exchange`;
const CSRF_ROTATION_PATH = `${API_PREFIX}/session/csrf`;
const HEALTH_PATH = "/health";
const MUTATION_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE"
]);

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

export type StudioControlApiOptions = {
  readonly sessions: StudioLocalSessionManager;
  readonly queries: StudioControlApiQueries;
  readonly inputRouting: StudioInputRoutingControl;
};

class StudioRequestValidationError extends Error {
  constructor() {
    super("The Studio request body is invalid");
    this.name = "StudioRequestValidationError";
  }
}

function parseRequest<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new StudioRequestValidationError();
  }
  return parsed.data;
}

function requestPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] ?? request.url;
}

function sessionRequest(request: FastifyRequest): StudioSessionRequest {
  const csrfHeader = request.headers["x-luna-csrf"];
  return {
    ...(request.headers.host === undefined
      ? {}
      : { host: request.headers.host }),
    ...(request.headers.origin === undefined
      ? {}
      : { origin: request.headers.origin }),
    ...(request.headers.cookie === undefined
      ? {}
      : { cookie: request.headers.cookie }),
    ...(typeof csrfHeader !== "string" ? {} : { csrfToken: csrfHeader }),
    ...(request.headers["content-type"] === undefined
      ? {}
      : { contentType: request.headers["content-type"] }),
    ...(request.headers["sec-fetch-site"] === undefined
      ? {}
      : { secFetchSite: request.headers["sec-fetch-site"] })
  };
}

function principalFor(
  request: FastifyRequest,
  sessions: StudioLocalSessionManager
): StudioLocalPrincipal {
  return MUTATION_METHODS.has(request.method)
    ? sessions.authenticateMutation(sessionRequest(request))
    : sessions.authenticateRead(sessionRequest(request));
}

function statusForSessionError(error: StudioSessionError): number {
  switch (error.code) {
    case "studio_session_missing":
    case "studio_session_invalid":
    case "studio_session_expired":
    case "studio_bootstrap_invalid":
    case "studio_bootstrap_consumed":
      return 401;
    case "studio_content_type_invalid":
      return 415;
    default:
      return 403;
  }
}

function errorEnvelope(
  request: FastifyRequest,
  code: string,
  message: string
): StudioHttpErrorEnvelope {
  return StudioHttpErrorEnvelopeSchema.parse({
    error: {
      code,
      message,
      details: {},
      request_id: request.id
    }
  });
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string
): void {
  void reply.code(statusCode).send(errorEnvelope(request, code, message));
}

function requireJsonContentType(request: FastifyRequest): void {
  const mediaType = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new StudioSessionError(
      "studio_content_type_invalid",
      "Studio mutations require Content-Type application/json"
    );
  }
}

function fastifyParserError(error: unknown):
  | {
      readonly statusCode: 400 | 413;
      readonly code: "studio_request_invalid" | "studio_request_too_large";
      readonly message: string;
    }
  | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return {
      statusCode: 413,
      code: "studio_request_too_large",
      message: "The Studio request body exceeds the configured size limit"
    };
  }
  if (
    code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
    code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH"
  ) {
    return {
      statusCode: 400,
      code: "studio_request_invalid",
      message: "The Studio request body is invalid"
    };
  }
  return undefined;
}

function securityHeaders(reply: FastifyReply): void {
  const contentSecurityPolicy = [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-elem 'self'",
    "style-src-attr 'unsafe-inline'",
    "worker-src 'self' blob:"
  ].join("; ");

  reply
    .header("Cache-Control", "no-store")
    .header("Cross-Origin-Opener-Policy", "same-origin")
    .header("Cross-Origin-Resource-Policy", "same-origin")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY")
    .header("Content-Security-Policy", contentSecurityPolicy);
}

export async function registerStudioControlApi(
  server: FastifyInstance,
  options: StudioControlApiOptions
): Promise<void> {
  const principals = new WeakMap<FastifyRequest, StudioLocalPrincipal>();
  const authenticatedPrincipal = (
    request: FastifyRequest
  ): StudioLocalPrincipal => {
    const principal = principals.get(request);
    if (principal === undefined) {
      throw new Error("Studio request reached a protected route without a principal");
    }
    return principal;
  };

  server.addHook("onRequest", async (request, reply) => {
    const path = requestPath(request);
    const source = sessionRequest(request);
    try {
      // This hook is intentionally global: assets and not-found responses are
      // protected against DNS rebinding just like Control API routes.
      options.sessions.validatePublicRequest(source);

      if (path === HEALTH_PATH) {
        return;
      }
      if (path === SESSION_EXCHANGE_PATH) {
        requireJsonContentType(request);
        options.sessions.validatePublicRequest(source, true);
        return;
      }
      if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
        principals.set(request, principalFor(request, options.sessions));
      }
    } catch (cause) {
      if (cause instanceof StudioSessionError) {
        sendError(
          request,
          reply,
          statusForSessionError(cause),
          cause.code,
          cause.message
        );
        return reply;
      }
      throw cause;
    }
  });

  server.addHook("onSend", async (_request, reply, payload) => {
    securityHeaders(reply);
    return payload;
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof StudioSessionError) {
      sendError(
        request,
        reply,
        statusForSessionError(error),
        error.code,
        error.message
      );
      return;
    }
    if (error instanceof StudioRequestValidationError) {
      sendError(
        request,
        reply,
        400,
        "studio_request_invalid",
        error.message
      );
      return;
    }
    const parserError = fastifyParserError(error);
    if (parserError !== undefined) {
      sendError(
        request,
        reply,
        parserError.statusCode,
        parserError.code,
        parserError.message
      );
      return;
    }
    const domainError = studioDomainHttpError(error);
    if (domainError !== undefined) {
      sendError(
        request,
        reply,
        domainError.statusCode,
        domainError.code,
        domainError.message
      );
      return;
    }

    request.log.error({ err: error }, "Studio request failed");
    sendError(
      request,
      reply,
      500,
      "studio_internal_error",
      "The Studio request could not be completed"
    );
  });

  server.setNotFoundHandler((request, reply) => {
    sendError(
      request,
      reply,
      404,
      "studio_not_found",
      "The requested Studio resource was not found"
    );
  });

  server.get(HEALTH_PATH, async () =>
    StudioHealthResponseSchema.parse({ status: "ok" })
  );

  server.post(SESSION_EXCHANGE_PATH, async (request, reply) => {
    const body = parseRequest(
      StudioSessionExchangeRequestSchema,
      request.body
    );
    const exchange = options.sessions.exchange(
      body.capability,
      sessionRequest(request)
    );
    reply.header("Set-Cookie", exchange.setCookie);
    return StudioSessionStateResponseSchema.parse({
      csrf_token: exchange.csrfToken,
      expires_at: exchange.expiresAt,
      principal: exchange.principal,
      mode: "local-single-user"
    });
  });

  server.post(CSRF_ROTATION_PATH, async (request) => {
    parseRequest(StudioCsrfRotationRequestSchema, request.body);
    const rotation = options.sessions.rotateCsrf(sessionRequest(request));
    return StudioSessionStateResponseSchema.parse({
      csrf_token: rotation.csrfToken,
      expires_at: rotation.expiresAt,
      principal: rotation.principal,
      mode: "local-single-user"
    });
  });

  server.get(`${API_PREFIX}/library`, async (request) =>
    StudioCapabilityCatalogSchema.parse(
      await options.queries.capabilities(authenticatedPrincipal(request))
    )
  );
  server.get(`${API_PREFIX}/agents`, async (request) =>
    StudioAgentCatalogSchema.parse(
      await options.queries.agents(authenticatedPrincipal(request))
    )
  );
  server.get(`${API_PREFIX}/workflows`, async (request) =>
    StudioWorkflowCatalogSchema.parse(
      await options.queries.workflows(authenticatedPrincipal(request))
    )
  );

  await registerStudioInputRoutingRoutes(server, {
    apiPrefix: API_PREFIX,
    control: options.inputRouting,
    principalFor: authenticatedPrincipal,
    parseRequest
  });
}
