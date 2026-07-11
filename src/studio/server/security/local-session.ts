import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { StudioLocalPrincipal } from "../../contracts/control-api.js";

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const SESSION_COOKIE_NAME = "luna_studio_session";

export type StudioSessionExchange = {
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly setCookie: string;
  readonly principal: StudioLocalPrincipal;
};

export type StudioCsrfRotation = {
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly principal: StudioLocalPrincipal;
};

export type StudioAuthenticatedLocalSession = {
  readonly principal: StudioLocalPrincipal;
  /** Server-only capability that binds confirmations to one HttpOnly session. */
  readonly actorBinding: string;
};

export type StudioSessionRequest = {
  readonly host?: string;
  readonly origin?: string;
  readonly cookie?: string;
  readonly csrfToken?: string;
  readonly contentType?: string;
  readonly secFetchSite?: string;
};

export type StudioLocalSessionOptions = {
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly now?: () => number;
  readonly sessionTtlMs?: number;
  readonly secureCookie?: boolean;
};

export type StudioSessionErrorCode =
  | "studio_host_forbidden"
  | "studio_origin_forbidden"
  | "studio_cross_site_forbidden"
  | "studio_bootstrap_invalid"
  | "studio_bootstrap_consumed"
  | "studio_session_missing"
  | "studio_session_invalid"
  | "studio_session_expired"
  | "studio_csrf_invalid"
  | "studio_content_type_invalid";

export class StudioSessionError extends Error {
  readonly code: StudioSessionErrorCode;

  constructor(code: StudioSessionErrorCode, message: string) {
    super(message);
    this.name = "StudioSessionError";
    this.code = code;
  }
}

type SessionRecord = {
  readonly csrfToken: string;
  readonly actorBinding: string;
  readonly expiresAtMs: number;
};

type LocatedSession = {
  readonly key: string;
  readonly record: SessionRecord;
};

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function tokenKey(token: string): string {
  return tokenDigest(token).toString("base64url");
}

function tokensEqual(left: string, right: string): boolean {
  return timingSafeEqual(tokenDigest(left), tokenDigest(right));
}

function normalizedMediaType(contentType: string | undefined): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  for (const item of cookieHeader?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const candidateName = item.slice(0, separator).trim();
    if (candidateName === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function requireNonEmptySet(values: readonly string[], label: string): Set<string> {
  if (values.length === 0 || values.some((value) => value.trim() === "")) {
    throw new TypeError(`${label} must contain at least one non-empty value`);
  }
  return new Set(values);
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function requireSessionTtl(value: number): void {
  requirePositiveSafeInteger(value, "Studio sessionTtlMs");
  if (value > MAX_SESSION_TTL_MS) {
    throw new TypeError(
      `Studio sessionTtlMs must not exceed ${MAX_SESSION_TTL_MS}`
    );
  }
}

function requireValidTimestamp(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Math.abs(value) > MAX_DATE_TIMESTAMP_MS
  ) {
    throw new RangeError(`${label} is outside the valid Date range`);
  }
  return value;
}

function sessionExpiry(nowMs: number, ttlMs: number): {
  readonly expiresAtMs: number;
  readonly expiresAt: string;
} {
  requireValidTimestamp(nowMs, "Studio clock timestamp");
  const expiresAtMs = nowMs + ttlMs;
  requireValidTimestamp(expiresAtMs, "Studio session expiry");
  return {
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString()
  };
}

export class StudioLocalSessionManager {
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly secureCookie: boolean;
  private bootstrapToken: string | undefined;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(options: StudioLocalSessionOptions) {
    this.allowedHosts = requireNonEmptySet(
      options.allowedHosts,
      "Studio allowedHosts"
    );
    this.allowedOrigins = requireNonEmptySet(
      options.allowedOrigins,
      "Studio allowedOrigins"
    );
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    requireSessionTtl(this.sessionTtlMs);
    this.secureCookie = options.secureCookie ?? false;
    this.bootstrapToken = opaqueToken();
  }

  bootstrapCapability(): string {
    if (this.bootstrapToken === undefined) {
      throw new StudioSessionError(
        "studio_bootstrap_consumed",
        "The Studio bootstrap capability has already been consumed"
      );
    }
    return this.bootstrapToken;
  }

  exchange(
    capability: string,
    request: Pick<StudioSessionRequest, "host" | "origin" | "secFetchSite">
  ): StudioSessionExchange {
    this.assertRequestSource(request, true);
    const bootstrapToken = this.bootstrapToken;
    if (bootstrapToken === undefined) {
      throw new StudioSessionError(
        "studio_bootstrap_consumed",
        "The Studio bootstrap capability has already been consumed"
      );
    }
    if (!tokensEqual(capability, bootstrapToken)) {
      throw new StudioSessionError(
        "studio_bootstrap_invalid",
        "The Studio bootstrap capability is invalid"
      );
    }

    const exchange = this.createSession();

    // Consume the one-time capability only after every fallible value needed
    // by the response has been validated and materialized.
    this.bootstrapToken = undefined;
    return exchange;
  }

  establishLocal(request: StudioSessionRequest): StudioSessionExchange {
    this.assertRequestSource(request, true);
    this.assertJsonContentType(request.contentType);
    return this.createSession();
  }

  validatePublicRequest(
    request: Pick<StudioSessionRequest, "host" | "origin" | "secFetchSite">,
    requireOrigin = false
  ): void {
    this.assertRequestSource(request, requireOrigin);
  }

  authenticateRead(request: StudioSessionRequest): StudioLocalPrincipal {
    return this.authenticateReadSession(request).principal;
  }

  authenticateMutation(request: StudioSessionRequest): StudioLocalPrincipal {
    return this.authenticateMutationSession(request).principal;
  }

  authenticateReadSession(
    request: StudioSessionRequest
  ): StudioAuthenticatedLocalSession {
    this.assertRequestSource(request, false);
    return this.authenticatedSession(this.requireSession(request.cookie));
  }

  authenticateMutationSession(
    request: StudioSessionRequest
  ): StudioAuthenticatedLocalSession {
    return this.authenticatedSession(this.requireMutationSession(request));
  }

  recoverCsrf(request: StudioSessionRequest): StudioCsrfRotation {
    this.assertRequestSource(request, true);
    this.assertJsonContentType(request.contentType);
    const session = this.requireSession(request.cookie);

    return {
      csrfToken: session.record.csrfToken,
      expiresAt: new Date(session.record.expiresAtMs).toISOString(),
      principal: { id: "local-user", authentication: "local-session" }
    };
  }

  private assertJsonContentType(contentType: string | undefined): void {
    if (normalizedMediaType(contentType) !== "application/json") {
      throw new StudioSessionError(
        "studio_content_type_invalid",
        "Studio mutations require Content-Type application/json"
      );
    }
  }

  private authenticatedSession(
    session: LocatedSession
  ): StudioAuthenticatedLocalSession {
    return {
      principal: { id: "local-user", authentication: "local-session" },
      actorBinding: session.record.actorBinding
    };
  }

  private createSession(): StudioSessionExchange {
    const sessionToken = opaqueToken();
    const csrfToken = opaqueToken();
    const actorBinding = opaqueToken();
    const expiry = sessionExpiry(this.now(), this.sessionTtlMs);
    this.sessions.set(tokenKey(sessionToken), {
      csrfToken,
      actorBinding,
      expiresAtMs: expiry.expiresAtMs
    });
    return {
      csrfToken,
      expiresAt: expiry.expiresAt,
      setCookie: this.sessionCookie(sessionToken),
      principal: {
        id: "local-user",
        authentication: "local-session"
      }
    };
  }

  private requireMutationSession(
    request: StudioSessionRequest
  ): LocatedSession {
    this.assertRequestSource(request, true);
    this.assertJsonContentType(request.contentType);
    const session = this.requireSession(request.cookie);
    if (
      request.csrfToken === undefined ||
      !tokensEqual(request.csrfToken, session.record.csrfToken)
    ) {
      throw new StudioSessionError(
        "studio_csrf_invalid",
        "The Studio CSRF token is invalid"
      );
    }
    return session;
  }

  private assertRequestSource(
    request: Pick<StudioSessionRequest, "host" | "origin" | "secFetchSite">,
    requireOrigin: boolean
  ): void {
    if (request.host === undefined || !this.allowedHosts.has(request.host)) {
      throw new StudioSessionError(
        "studio_host_forbidden",
        "The request Host is not allowed by the Studio server"
      );
    }
    if (
      request.secFetchSite !== undefined &&
      request.secFetchSite !== "same-origin" &&
      request.secFetchSite !== "none"
    ) {
      throw new StudioSessionError(
        "studio_cross_site_forbidden",
        "Cross-site requests are not allowed by the Studio server"
      );
    }
    if (
      (requireOrigin || request.origin !== undefined) &&
      (request.origin === undefined ||
        !this.allowedOrigins.has(request.origin))
    ) {
      throw new StudioSessionError(
        "studio_origin_forbidden",
        "The request Origin is not allowed by the Studio server"
      );
    }
  }

  private requireSession(cookieHeader: string | undefined): LocatedSession {
    const sessionToken = parseCookie(
      cookieHeader,
      SESSION_COOKIE_NAME
    );
    if (sessionToken === undefined) {
      throw new StudioSessionError(
        "studio_session_missing",
        "The Studio local session cookie is missing"
      );
    }
    const sessionKey = tokenKey(sessionToken);
    const session = this.sessions.get(sessionKey);
    if (session === undefined) {
      throw new StudioSessionError(
        "studio_session_invalid",
        "The Studio local session is invalid"
      );
    }
    const now = requireValidTimestamp(
      this.now(),
      "Studio clock timestamp"
    );
    if (now >= session.expiresAtMs) {
      this.sessions.delete(sessionKey);
      throw new StudioSessionError(
        "studio_session_expired",
        "The Studio local session has expired"
      );
    }
    return { key: sessionKey, record: session };
  }

  private sessionCookie(sessionToken: string): string {
    const maxAgeSeconds = Math.max(1, Math.floor(this.sessionTtlMs / 1000));
    return [
      `${SESSION_COOKIE_NAME}=${sessionToken}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      ...(this.secureCookie ? ["Secure"] : []),
      `Max-Age=${maxAgeSeconds}`
    ].join("; ");
  }
}
