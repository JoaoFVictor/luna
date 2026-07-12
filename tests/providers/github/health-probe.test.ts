import { describe, expect, it, vi } from "vitest";
import { createGitHubHealthProbe } from "../../../src/providers/github/health-probe.js";

describe("GitHub provider health probe", () => {
  it("performs only the authenticated-user read and declares exact effects", async () => {
    const run = vi.fn(async () => "private-login\n");
    const probe = createGitHubHealthProbe({ run });
    const result = await probe.run({
      projectRoot: "/project",
      configRoot: "/config",
      signal: new AbortController().signal
    });

    expect(probe.effects).toEqual([
      "credential_read",
      "network_read",
      "process_execution"
    ]);
    expect(run).toHaveBeenCalledWith(
      "/project",
      ["api", "user", "--jq", ".login"],
      expect.objectContaining({ timeoutMs: 10_000 })
    );
    expect(result.summary).not.toContain("private-login");
  });
});
