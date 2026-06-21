import { describe, expect, it } from "vitest";
import { resolveSubagentPolicy } from "../../src/core/agents/subagent-policy.js";

describe("subagent policy", () => {
  it("returns read-only defaults when no override is provided", () => {
    expect(resolveSubagentPolicy(undefined, undefined)).toEqual({
      mode: "read_only",
      allow_tools: []
    });
  });

  it("allows explicit trusted write only with workflow permission and tool allowlist", () => {
    expect(
      resolveSubagentPolicy(
        { allow_write: true },
        {
          mode: "trusted_host_local_write",
          allow_tools: ["repository.status"]
        }
      )
    ).toEqual({
      mode: "trusted_host_local_write",
      allow_tools: ["repository.status"]
    });
  });

  it("rejects trusted write when workflow policy disallows write", () => {
    expect(() =>
      resolveSubagentPolicy(
        { allow_write: false },
        {
          mode: "trusted_host_local_write",
          allow_tools: ["repository.status"]
        }
      )
    ).toThrow("Subagent write mode is not allowed by workflow policy");
    expect(() =>
      resolveSubagentPolicy(
        { allow_write: false },
        {
          mode: "trusted_host_local_write",
          allow_tools: ["repository.status"]
        }
      )
    ).toThrow(
      expect.objectContaining({ code: "subagent_write_not_allowed" })
    );
  });

  it("rejects trusted write without an explicit tool allowlist", () => {
    expect(() =>
      resolveSubagentPolicy(
        { allow_write: true },
        { mode: "trusted_host_local_write" }
      )
    ).toThrow("Trusted write subagents require an explicit allow_tools list");
    expect(() =>
      resolveSubagentPolicy(
        { allow_write: true },
        { mode: "trusted_host_local_write" }
      )
    ).toThrow(
      expect.objectContaining({ code: "subagent_write_allow_tools_required" })
    );
  });

  it("rejects read-only policy overrides with an allow_tools list", () => {
    expect(() =>
      resolveSubagentPolicy(
        undefined,
        { mode: "read_only", allow_tools: ["repository.status"] }
      )
    ).toThrow(
      expect.objectContaining({ code: "subagent_read_only_allow_tools_invalid" })
    );
  });
});
