import { describe, expect, it } from "vitest";
import {
  StudioLocalSessionManager,
  type StudioSessionExchange
} from "../../../src/studio/server/security/local-session.js";

const host = "127.0.0.1:43110";
const origin = "http://127.0.0.1:43110";

function manager(now: () => number = () => 1_000): StudioLocalSessionManager {
  return new StudioLocalSessionManager({
    allowedHosts: [host],
    allowedOrigins: [origin],
    now,
    sessionTtlMs: 60_000
  });
}

function exchange(sessionManager: StudioLocalSessionManager): StudioSessionExchange {
  return sessionManager.exchange(sessionManager.bootstrapCapability(), {
    host,
    origin,
    secFetchSite: "same-origin"
  });
}

describe("Studio local session manager", () => {
  it("establishes a same-origin local session without a launch capability", () => {
    const sessionManager = manager();
    const capability = sessionManager.bootstrapCapability();
    const result = sessionManager.establishLocal({
      host,
      origin,
      contentType: "application/json",
      secFetchSite: "same-origin"
    });

    expect(result.setCookie).toContain("luna_studio_session=");
    expect(result.setCookie).toContain("HttpOnly");
    expect(result.setCookie).toContain("SameSite=Strict");
    expect(sessionManager.bootstrapCapability()).toBe(capability);
    expect(
      sessionManager.authenticateMutation({
        host,
        origin,
        cookie: result.setCookie,
        csrfToken: result.csrfToken,
        contentType: "application/json",
        secFetchSite: "same-origin"
      })
    ).toEqual({ id: "local-user", authentication: "local-session" });
  });

  it("rejects cross-origin or non-JSON local session establishment", () => {
    const sessionManager = manager();
    const request = {
      host,
      origin,
      contentType: "application/json",
      secFetchSite: "same-origin"
    } as const;

    expect(() =>
      sessionManager.establishLocal({
        ...request,
        origin: "https://evil.example"
      })
    ).toThrow(expect.objectContaining({ code: "studio_origin_forbidden" }));
    expect(() =>
      sessionManager.establishLocal({ ...request, contentType: "text/plain" })
    ).toThrow(expect.objectContaining({ code: "studio_content_type_invalid" }));
  });

  it("exchanges a one-time startup capability for an HttpOnly session", () => {
    const sessionManager = manager();
    const result = exchange(sessionManager);

    expect(result.principal).toEqual({
      id: "local-user",
      authentication: "local-session"
    });
    expect(result.setCookie).toContain("luna_studio_session=");
    expect(result.setCookie).toContain("HttpOnly");
    expect(result.setCookie).toContain("SameSite=Strict");
    expect(result.setCookie).not.toContain(result.csrfToken);
    expect(() => sessionManager.bootstrapCapability()).toThrow(
      expect.objectContaining({ code: "studio_bootstrap_consumed" })
    );
  });

  it("authenticates reads without exposing the session capability to JavaScript", () => {
    const sessionManager = manager();
    const result = exchange(sessionManager);

    expect(
      sessionManager.authenticateRead({ host, cookie: result.setCookie })
    ).toEqual({ id: "local-user", authentication: "local-session" });
  });

  it("requires allowed origin, JSON, cookie, and CSRF for mutations", () => {
    const sessionManager = manager();
    const result = exchange(sessionManager);
    const validRequest = {
      host,
      origin,
      cookie: result.setCookie,
      csrfToken: result.csrfToken,
      contentType: "application/json; charset=utf-8",
      secFetchSite: "same-origin"
    } as const;

    expect(sessionManager.authenticateMutation(validRequest)).toEqual({
      id: "local-user",
      authentication: "local-session"
    });
    expect(() =>
      sessionManager.authenticateMutation({
        ...validRequest,
        origin: "https://evil.example"
      })
    ).toThrow(expect.objectContaining({ code: "studio_origin_forbidden" }));
    expect(() =>
      sessionManager.authenticateMutation({
        ...validRequest,
        csrfToken: "wrong"
      })
    ).toThrow(expect.objectContaining({ code: "studio_csrf_invalid" }));
    expect(() =>
      sessionManager.authenticateMutation({
        ...validRequest,
        contentType: "text/plain"
      })
    ).toThrow(expect.objectContaining({
      code: "studio_content_type_invalid"
    }));
  });

  it("recovers a CSRF token through the authenticated same-origin session", () => {
    const sessionManager = manager();
    const result = exchange(sessionManager);
    const request = {
      host,
      origin,
      cookie: result.setCookie,
      csrfToken: result.csrfToken,
      contentType: "application/json",
      secFetchSite: "same-origin"
    } as const;
    const rotated = sessionManager.recoverCsrf(request);

    expect(rotated.csrfToken).toBe(result.csrfToken);
    expect(rotated.expiresAt).toBe(result.expiresAt);
    expect(
      sessionManager.authenticateMutation({
        ...request,
        csrfToken: rotated.csrfToken
      })
    ).toEqual({ id: "local-user", authentication: "local-session" });
    expect(() => sessionManager.bootstrapCapability()).toThrow(
      expect.objectContaining({ code: "studio_bootstrap_consumed" })
    );
  });

  it("requires a session and same origin to rotate CSRF", () => {
    const sessionManager = manager();
    const result = exchange(sessionManager);
    const request = {
      host,
      origin,
      cookie: result.setCookie,
      csrfToken: result.csrfToken,
      contentType: "application/json"
    } as const;

    expect(() =>
      sessionManager.recoverCsrf({ ...request, origin: "https://evil.example" })
    ).toThrow(expect.objectContaining({ code: "studio_origin_forbidden" }));
    expect(() =>
      sessionManager.recoverCsrf({ ...request, cookie: undefined })
    ).toThrow(expect.objectContaining({ code: "studio_session_missing" }));
    expect(sessionManager.recoverCsrf({
      ...request,
      csrfToken: "wrong"
    }).csrfToken).toBe(result.csrfToken);
  });

  it("rejects unsafe TTLs and preserves bootstrap after an invalid clock", () => {
    expect(
      () => new StudioLocalSessionManager({
        allowedHosts: [host],
        allowedOrigins: [origin],
        sessionTtlMs: Number.MAX_SAFE_INTEGER
      })
    ).toThrow(/must not exceed/);
    expect(
      () => new StudioLocalSessionManager({
        allowedHosts: [host],
        allowedOrigins: [origin],
        sessionTtlMs: Number.NaN
      })
    ).toThrow(/positive safe integer/);

    const sessionManager = manager(() => Number.MAX_SAFE_INTEGER);
    const capability = sessionManager.bootstrapCapability();
    expect(() =>
      sessionManager.exchange(capability, {
        host,
        origin,
        secFetchSite: "same-origin"
      })
    ).toThrow(/outside the valid Date range/);
    expect(sessionManager.bootstrapCapability()).toBe(capability);
  });

  it("rejects DNS rebinding and cross-site fetch metadata", () => {
    const sessionManager = manager();
    const result = exchange(sessionManager);

    expect(() =>
      sessionManager.authenticateRead({
        host: "attacker.example",
        cookie: result.setCookie
      })
    ).toThrow(expect.objectContaining({ code: "studio_host_forbidden" }));
    expect(() =>
      sessionManager.authenticateRead({
        host,
        cookie: result.setCookie,
        secFetchSite: "cross-site"
      })
    ).toThrow(expect.objectContaining({
      code: "studio_cross_site_forbidden"
    }));
  });

  it("expires server-side sessions", () => {
    let now = 1_000;
    const sessionManager = manager(() => now);
    const result = exchange(sessionManager);
    now = 61_000;

    expect(() =>
      sessionManager.authenticateRead({ host, cookie: result.setCookie })
    ).toThrow(expect.objectContaining({ code: "studio_session_expired" }));
  });
});
