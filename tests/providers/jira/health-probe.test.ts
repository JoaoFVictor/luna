import { describe, expect, it, vi } from "vitest";
import { createJiraHealthProbe } from "../../../src/providers/jira/health-probe.js";

describe("Jira provider health probe", () => {
  it("reads only /myself for configured instances and redacts credentials", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      new Response("{}", { status: 200 })
    );
    const probe = createJiraHealthProbe({
      loadAuth: async () => ({
        providers: {
          jira: {
            private: {
              base_url: "https://private.atlassian.net/",
              auth_type: "basic_api_token",
              email: "private@example.com",
              api_token: "credential-canary"
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
      "https://private.atlassian.net/rest/api/3/myself"
    );
    expect(request.mock.calls[0][1]).toMatchObject({ method: "GET" });
    expect(JSON.stringify(result)).not.toContain("credential-canary");
    expect(JSON.stringify(result)).not.toContain("private@example.com");
    expect(JSON.stringify(result)).not.toContain("private.atlassian.net");
  });
});
