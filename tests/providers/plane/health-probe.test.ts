import { describe, expect, it, vi } from "vitest";
import { createPlaneHealthProbe } from "../../../src/providers/plane/health-probe.js";

describe("Plane provider health probe", () => {
  it("reads only the current user endpoint and redacts credentials", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      new Response("{}", { status: 200 })
    );
    const probe = createPlaneHealthProbe({
      loadAuth: async () => ({
        providers: {
          plane: {
            private: {
              base_url: "https://app.plane.so/",
              auth_type: "api_key",
              api_key: "credential-canary"
            }
          }
        }
      }),
      fetch: request
    });
    const result = await probe.run({
      projectRoot: "/project",
      configRoot: "/config",
      signal: new AbortController().signal
    });

    expect(probe.effects).toEqual(["credential_read", "network_read"]);
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0][0])).toBe(
      "https://api.plane.so/api/v1/users/me/"
    );
    expect(request.mock.calls[0][1]).toMatchObject({
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-API-Key": "credential-canary"
      }
    });
    expect(JSON.stringify(result)).not.toContain("credential-canary");
    expect(JSON.stringify(result)).not.toContain("api.plane.so");
  });

  it("keeps the configured origin for self-hosted Plane", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      new Response("{}", { status: 200 })
    );
    const probe = createPlaneHealthProbe({
      loadAuth: async () => ({
        providers: {
          plane: {
            self_hosted: {
              base_url: "https://plane.internal.example/root/",
              auth_type: "api_key",
              api_key: "secret"
            }
          }
        }
      }),
      fetch: request
    });

    await probe.run({
      projectRoot: "/project",
      configRoot: "/config",
      signal: new AbortController().signal
    });

    expect(String(request.mock.calls[0][0])).toBe(
      "https://plane.internal.example/api/v1/users/me/"
    );
  });
});
