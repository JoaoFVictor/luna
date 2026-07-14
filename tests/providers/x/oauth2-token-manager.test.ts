import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadXAuth,
  persistXAuthInstance
} from "../../../src/providers/x/auth.js";
import { createXOAuth2TokenManager } from "../../../src/providers/x/oauth2-token-manager.js";

const roots: string[] = [];
const now = Date.parse("2026-07-13T20:00:00.000Z");

async function fixture(auth: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-x-oauth-"));
  roots.push(root);
  const authRoot = path.join(root, ".luna", "auth");
  await mkdir(authRoot, { recursive: true });
  await writeFile(
    path.join(authRoot, "luna.auth.json"),
    `${JSON.stringify({
      providers: {
        plane: { default: { api_key: "unrelated-provider-value" } },
        x: { default: auth }
      }
    }, null, 2)}\n`,
    { mode: 0o644 }
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("X OAuth 2.0 token manager", () => {
  it("provisions the first X instance while preserving other providers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-x-oauth-"));
    roots.push(root);
    const authRoot = path.join(root, ".luna", "auth");
    await mkdir(authRoot, { recursive: true });
    await writeFile(
      path.join(authRoot, "luna.auth.json"),
      `${JSON.stringify({
        providers: {
          plane: { default: { api_key: "unrelated-provider-value" } }
        }
      }, null, 2)}\n`
    );

    await persistXAuthInstance(root, "default", {
      auth_type: "oauth2_user_access_token",
      access_token: "access",
      refresh_token: "refresh",
      client_id: "public-client"
    });

    await expect(loadXAuth(root)).resolves.toMatchObject({
      providers: {
        plane: { default: { api_key: "unrelated-provider-value" } },
        x: {
          default: {
            access_token: "access",
            refresh_token: "refresh",
            client_id: "public-client"
          }
        }
      }
    });
  });

  it("refreshes an expiring public-client token and atomically persists rotation", async () => {
    const root = await fixture({
      auth_type: "oauth2_user_access_token",
      access_token: "old-access",
      refresh_token: "old-refresh",
      client_id: "public-client",
      expires_at: "2026-07-13T20:00:30.000Z"
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 7200
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const token = await createXOAuth2TokenManager({
      projectRoot: root,
      instanceId: "default",
      fetch: fetchImpl,
      now: () => now
    }).accessToken();

    expect(token).toBe("new-access");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.x.com/2/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&refresh_token=old-refresh&client_id=public-client"
      }
    );
    const persisted = JSON.parse(await readFile(
      path.join(root, ".luna", "auth", "luna.auth.json"),
      "utf8"
    )) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      providers: {
        plane: { default: { api_key: "unrelated-provider-value" } },
        x: {
          default: {
            access_token: "new-access",
            refresh_token: "new-refresh",
            client_id: "public-client",
            expires_at: "2026-07-13T22:00:00.000Z"
          }
        }
      }
    });
    expect((await stat(path.join(root, ".luna", "auth", "luna.auth.json"))).mode & 0o777)
      .toBe(0o600);
  });

  it("uses HTTP Basic client authentication for a confidential client", async () => {
    const auth = {
      auth_type: "oauth2_user_access_token" as const,
      access_token: "old-access",
      refresh_token: "old-refresh",
      client_id: "confidential-client",
      client_secret: "client-secret",
      expires_at: "2026-07-13T19:59:00.000Z"
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: "new-access",
      expires_in: 3600
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    let persisted = auth;

    await createXOAuth2TokenManager({
      projectRoot: "/repo",
      instanceId: "default",
      fetch: fetchImpl,
      loadAuth: async () => ({ providers: { x: { default: persisted } } }),
      persistAuth: async (_root, _instance, next) => {
        persisted = next as typeof auth;
      },
      acquireRefreshLock: async () => async () => undefined,
      now: () => now
    }).accessToken();

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.x.com/2/oauth2/token",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(
            "confidential-client:client-secret"
          ).toString("base64")}`
        },
        body: "grant_type=refresh_token&refresh_token=old-refresh"
      }
    );
    expect(persisted).toMatchObject({
      access_token: "new-access",
      refresh_token: "old-refresh",
      client_secret: "client-secret"
    });
  });

  it("serializes concurrent refreshes and reuses the credential persisted by the winner", async () => {
    const root = await fixture({
      auth_type: "oauth2_user_access_token",
      access_token: "old-access",
      refresh_token: "old-refresh",
      client_id: "public-client",
      expires_at: "2026-07-13T19:59:00.000Z"
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 7200
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const manager = () => createXOAuth2TokenManager({
      projectRoot: root,
      instanceId: "default",
      fetch: fetchImpl,
      now: () => now
    });

    await expect(Promise.all([
      manager().accessToken(),
      manager().accessToken()
    ])).resolves.toEqual(["new-access", "new-access"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects incomplete refresh configuration while keeping access-only auth valid", async () => {
    const root = await fixture({
      auth_type: "oauth2_user_access_token",
      access_token: "old-access",
      refresh_token: "old-refresh"
    });
    await expect(loadXAuth(root)).rejects.toMatchObject({
      code: "luna_auth_invalid"
    });

    await persistXAuthInstance(root, "default", {
      auth_type: "oauth2_user_access_token",
      access_token: "access-only"
    });
    await expect(loadXAuth(root)).resolves.toMatchObject({
      providers: {
        x: { default: { access_token: "access-only" } }
      }
    });
  });
});
