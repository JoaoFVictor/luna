import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodType, ZodTypeDef } from "zod";
import {
  StudioHttpErrorEnvelopeSchema,
  type StudioHttpErrorEnvelope,
  type StudioLocalPrincipal
} from "../contracts/control-api.js";
import { studioDomainHttpError } from "./domain-error.js";
import {
  StudioLocalSessionManager,
  StudioSessionError,
  type StudioAuthenticatedLocalSession,
  type StudioSessionRequest
} from "./security/local-session.js";

export const STUDIO_API_PREFIX = "/api/studio/v1";
export const STUDIO_SESSION_EXCHANGE_PATH =
  `${STUDIO_API_PREFIX}/session/exchange`;
export const STUDIO_CSRF_ROTATION_PATH = `${STUDIO_API_PREFIX}/session/csrf`;
export const STUDIO_HEALTH_PATH = "/health";

const MUTATION_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE"
]);

export type StudioControlApiRequestAccess = {
  readonly authenticatedSessionFor: (
    request: FastifyRequest
  ) => StudioAuthenticatedLocalSession;
  readonly principalFor: (
    request: FastifyRequest
  ) => StudioLocalPrincipal;
  readonly requestIdFor: (request: FastifyRequest) => string;
};

class StudioRequestValidationError extends Error {
  constructor() {
    super("The Studio request body is invalid");
    this.name = "StudioRequestValidationError";
  }
}

export function parseStudioRequest<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  value: unknown
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new StudioRequestValidationError();
  }
  return parsed.data;
}

function requestPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] ?? request.url;
}

export function studioSessionRequest(
  request: FastifyRequest
): StudioSessionRequest {
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

function authenticateRequest(
  request: FastifyRequest,
  sessions: StudioLocalSessionManager
): StudioAuthenticatedLocalSession {
  return MUTATION_METHODS.has(request.method)
    ? sessions.authenticateMutationSession(studioSessionRequest(request))
    : sessions.authenticateReadSession(studioSessionRequest(request));
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
  message: string,
  details: Readonly<
    Record<string, string | number | boolean | null>
  > = {}
): StudioHttpErrorEnvelope {
  return StudioHttpErrorEnvelopeSchema.parse({
    error: {
      code,
      message,
      details,
      request_id: request.id
    }
  });
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details: Readonly<
    Record<string, string | number | boolean | null>
  > = {}
): void {
  void reply
    .code(statusCode)
    .send(errorEnvelope(request, code, message, details));
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

function securityHeaders(request: FastifyRequest, reply: FastifyReply): void {
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
  const path = requestPath(request);

  if (
    !path.startsWith("/assets/") &&
    path !== "/favicon.svg" &&
    path !== "/icons.svg"
  ) {
    const contentType = reply.getHeader("Content-Type");
    reply.header(
      "Cache-Control",
      typeof contentType === "string" &&
        contentType.startsWith("text/event-stream")
        ? "no-store, no-transform"
        : "no-store"
    );
  }
  reply
    .header("Cross-Origin-Opener-Policy", "same-origin")
    .header("Cross-Origin-Resource-Policy", "same-origin")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY")
    .header("Content-Security-Policy", contentSecurityPolicy);
}

function requestIdFor(request: FastifyRequest): string {
  const digest = createHash("sha256")
    .update(request.id, "utf8")
    .digest("hex");
  return `request-${digest}`;
}

export function registerStudioControlApiBoundary(
  server: FastifyInstance,
  sessions: StudioLocalSessionManager
): StudioControlApiRequestAccess {
  const authentications = new WeakMap<
    FastifyRequest,
    StudioAuthenticatedLocalSession
  >();
  const authenticatedSessionFor = (
    request: FastifyRequest
  ): StudioAuthenticatedLocalSession => {
    const authenticated = authentications.get(request);
    if (authenticated === undefined) {
      throw new Error(
        "Studio request reached a protected route without a session"
      );
    }
    return authenticated;
  };
  const principalFor = (request: FastifyRequest): StudioLocalPrincipal =>
    authenticatedSessionFor(request).principal;

  server.addHook("onRequest", async (request, reply) => {
    const path = requestPath(request);
    const source = studioSessionRequest(request);
    try {
      // This hook is intentionally global: assets and not-found responses are
      // protected against DNS rebinding just like Control API routes.
      sessions.validatePublicRequest(source);

      if (path === STUDIO_HEALTH_PATH) {
        return;
      }
      if (path === STUDIO_SESSION_EXCHANGE_PATH) {
        requireJsonContentType(request);
        sessions.validatePublicRequest(source, true);
        return;
      }
      if (path === STUDIO_CSRF_ROTATION_PATH) {
        requireJsonContentType(request);
        sessions.validatePublicRequest(source, true);
        return;
      }
      if (
        path === STUDIO_API_PREFIX ||
        path.startsWith(`${STUDIO_API_PREFIX}/`)
      ) {
        authentications.set(request, authenticateRequest(request, sessions));
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

  server.addHook("onSend", async (request, reply, payload) => {
    securityHeaders(request, reply);
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
        domainError.message,
        domainError.details
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

  return {
    authenticatedSessionFor,
    principalFor,
    requestIdFor
  };
}
