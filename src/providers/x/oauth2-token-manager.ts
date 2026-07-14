import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { resolveLunaAuthRoot } from "../../core/auth/root.js";
import { RunLockManager, type ReleaseLock } from "../../core/workflow/lock-manager.js";
import {
  isXRefreshableAuth,
  loadXAuth,
  persistXAuthInstance,
  xAuthForInstance,
  type XAuth,
  type XLunaAuthConfig,
  type XRefreshableAuth
} from "./auth.js";

const X_OAUTH2_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const EXPIRY_SKEW_MS = 60_000;
const REFRESH_LOCK_TIMEOUT_MS = 30_000;
const REFRESH_LOCK_STALE_AFTER_MS = 120_000;

const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().int().positive().optional()
  })
  .passthrough();

type Fetch = typeof fetch;
type XAuthLoader = (projectRoot: string) => Promise<XLunaAuthConfig>;
type XAuthPersister = (
  projectRoot: string,
  instanceId: string,
  auth: XAuth
) => Promise<void>;
type XRefreshLockAcquirer = (
  projectRoot: string,
  instanceId: string
) => Promise<ReleaseLock>;

export type XOAuth2TokenManager = {
  accessToken(): Promise<string>;
  refreshAfterUnauthorized(
    rejectedAccessToken: string
  ): Promise<string | undefined>;
};

export type XOAuth2TokenManagerOptions = {
  readonly projectRoot: string;
  readonly instanceId: string;
  readonly fetch?: Fetch;
  readonly loadAuth?: XAuthLoader;
  readonly persistAuth?: XAuthPersister;
  readonly acquireRefreshLock?: XRefreshLockAcquirer;
  readonly now?: () => number;
};

type RefreshReason = "expiring" | "unauthorized";

function tokenManagerError(message: string, cause?: unknown): Error {
  return new Error(message, { cause });
}

async function defaultAcquireRefreshLock(
  projectRoot: string,
  instanceId: string
): Promise<ReleaseLock> {
  const manager = new RunLockManager({
    root: path.join(resolveLunaAuthRoot(projectRoot), ".locks"),
    runId: `x-oauth-refresh-${randomUUID()}`,
    timeoutMs: REFRESH_LOCK_TIMEOUT_MS,
    staleAfterMs: REFRESH_LOCK_STALE_AFTER_MS
  });
  return await manager.acquire(`x-oauth:${instanceId}`, "exclusive");
}

function tokenIsExpiring(auth: XRefreshableAuth, now: number): boolean {
  if (auth.expires_at === undefined) {
    return false;
  }
  return Date.parse(auth.expires_at) <= now + EXPIRY_SKEW_MS;
}

function refreshRequest(auth: XRefreshableAuth): RequestInit {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refresh_token
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded"
  };

  if (auth.client_secret === undefined) {
    body.set("client_id", auth.client_id);
  } else {
    headers.authorization = `Basic ${Buffer.from(
      `${auth.client_id}:${auth.client_secret}`,
      "utf8"
    ).toString("base64")}`;
  }

  return {
    method: "POST",
    headers,
    body: body.toString()
  };
}

function refreshedAuth(
  previous: XRefreshableAuth,
  response: z.infer<typeof TokenResponseSchema>,
  now: number
): XRefreshableAuth {
  return {
    auth_type: "oauth2_user_access_token",
    access_token: response.access_token,
    refresh_token: response.refresh_token ?? previous.refresh_token,
    client_id: previous.client_id,
    ...(previous.client_secret === undefined
      ? {}
      : { client_secret: previous.client_secret }),
    ...(response.expires_in === undefined
      ? {}
      : { expires_at: new Date(now + response.expires_in * 1000).toISOString() })
  };
}

async function requestRefreshedAuth(
  auth: XRefreshableAuth,
  fetchImpl: Fetch,
  now: () => number
): Promise<XRefreshableAuth> {
  let response: Response;
  try {
    response = await fetchImpl(X_OAUTH2_TOKEN_URL, refreshRequest(auth));
  } catch (cause) {
    throw tokenManagerError(
      "X OAuth token refresh could not reach the provider",
      cause
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw tokenManagerError(
      response.ok
        ? "X OAuth token refresh returned an invalid response"
        : `X OAuth token refresh failed with HTTP ${response.status}`,
      cause
    );
  }

  if (!response.ok) {
    throw tokenManagerError(
      `X OAuth token refresh failed with HTTP ${response.status}`
    );
  }

  const parsed = TokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw tokenManagerError(
      "X OAuth token refresh returned invalid credentials",
      parsed.error
    );
  }
  return refreshedAuth(auth, parsed.data, now());
}

export function createXOAuth2TokenManager({
  projectRoot,
  instanceId,
  fetch: fetchImpl = globalThis.fetch,
  loadAuth = loadXAuth,
  persistAuth = persistXAuthInstance,
  acquireRefreshLock = defaultAcquireRefreshLock,
  now = Date.now
}: XOAuth2TokenManagerOptions): XOAuth2TokenManager {
  async function currentAuth(): Promise<XAuth> {
    return xAuthForInstance(await loadAuth(projectRoot), instanceId);
  }

  async function refreshUnderLock(
    rejectedAccessToken: string,
    reason: RefreshReason
  ): Promise<string | undefined> {
    const release = await acquireRefreshLock(projectRoot, instanceId);
    let operationError: unknown;
    try {
      const auth = await currentAuth();
      if (auth.access_token !== rejectedAccessToken) {
        return auth.access_token;
      }
      if (!isXRefreshableAuth(auth)) {
        return undefined;
      }
      if (reason === "expiring" && !tokenIsExpiring(auth, now())) {
        return auth.access_token;
      }

      const next = await requestRefreshedAuth(auth, fetchImpl, now);
      await persistAuth(projectRoot, instanceId, next);
      return next.access_token;
    } catch (cause) {
      operationError = cause;
      throw cause;
    } finally {
      try {
        await release();
      } catch (releaseError) {
        if (operationError === undefined) {
          throw releaseError;
        }
      }
    }
  }

  return {
    async accessToken() {
      const auth = await currentAuth();
      if (!isXRefreshableAuth(auth) || !tokenIsExpiring(auth, now())) {
        return auth.access_token;
      }
      const refreshed = await refreshUnderLock(auth.access_token, "expiring");
      if (refreshed === undefined) {
        throw tokenManagerError("X OAuth credentials cannot be refreshed");
      }
      return refreshed;
    },

    async refreshAfterUnauthorized(rejectedAccessToken) {
      const auth = await currentAuth();
      if (auth.access_token !== rejectedAccessToken) {
        return auth.access_token;
      }
      if (!isXRefreshableAuth(auth)) {
        return undefined;
      }
      return await refreshUnderLock(rejectedAccessToken, "unauthorized");
    }
  };
}
