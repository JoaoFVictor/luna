import { describe, expect, it } from "vitest";
import { studioAgentTestError } from "../../../src/studio/application/agents/test-bench-errors.js";
import { studioAgentTestHttpError } from "../../../src/studio/server/agent-test-errors.js";

describe("Studio agent test public errors", () => {
  it("publishes only the bounded outcome-unknown diagnostic", () => {
    const mapped = studioAgentTestHttpError(studioAgentTestError(
      "studio_agent_test_outcome_unknown",
      "private provider diagnostic",
      {
        outcome_unknown: true,
        plan_id: `atp_${"p".repeat(32)}`,
        confirmation_token: "private-confirmation-token",
        fixture: "private-fixture",
        provider_response: "private-provider-response"
      }
    ));

    expect(mapped).toEqual({
      statusCode: 503,
      code: "studio_agent_test_outcome_unknown",
      message: "The real model call outcome could not be verified",
      details: {
        outcome_unknown: true,
        plan_id: `atp_${"p".repeat(32)}`
      }
    });
    expect(JSON.stringify(mapped)).not.toContain("private-");
  });

  it("does not publish internal details for deterministic failures", () => {
    const mapped = studioAgentTestHttpError(studioAgentTestError(
      "studio_agent_test_target_invalid",
      "unsafe private target message",
      { path: "/private/repository/agents/reviewer/agent.yaml" }
    ));

    expect(mapped).toEqual({
      statusCode: 409,
      code: "studio_agent_test_target_invalid",
      message: "The requested agent smoke target cannot be tested safely"
    });
    expect(JSON.stringify(mapped)).not.toContain("private/repository");
  });
});
