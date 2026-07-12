import { describe, expect, it } from "vitest";
import { MemoryStudioAgentTestConfirmations } from "../../../src/studio/adapters/memory/agent-test-confirmations.js";
import {
  studioAgentTestSecretDigest,
  studioAgentTestValueDigest
} from "../../../src/studio/application/agents/test-bench-digests.js";
import type { StudioAgentTestConfirmationBinding } from "../../../src/studio/application/agents/test-bench-ports.js";

const TOKEN = "a".repeat(43);
const ACTOR_A = studioAgentTestSecretDigest("actor-session-a");
const ACTOR_B = studioAgentTestSecretDigest("actor-session-b");

function binding(): StudioAgentTestConfirmationBinding {
  const request = {
    target: {
      kind: "installed" as const,
      agent_id: "reviewer",
      revision: studioAgentTestValueDigest({ agent: 1 })
    },
    fixture: { task: "review" },
    context: { kind: "none" as const }
  };
  return {
    planId: `atp_${"1".repeat(32)}`,
    actorBindingDigest: ACTOR_A,
    requestDigest: studioAgentTestValueDigest(request),
    snapshotHash: studioAgentTestValueDigest({ snapshot: 1 }),
    request
  };
}

describe("MemoryStudioAgentTestConfirmations", () => {
  it("binds consumption to the test plan and actor and projects the agent record", async () => {
    const confirmations = new MemoryStudioAgentTestConfirmations({
      now: () => 1_000,
      createToken: () => TOKEN
    });
    const value = binding();
    const issued = await confirmations.issue(value, { ttlMs: 500 });

    await expect(confirmations.consume(issued.token, {
      planId: value.planId,
      actorBindingDigest: ACTOR_B
    })).resolves.toBeUndefined();
    await expect(confirmations.consume(issued.token, {
      planId: `atp_${"2".repeat(32)}`,
      actorBindingDigest: ACTOR_A
    })).resolves.toBeUndefined();
    await expect(confirmations.consume(issued.token, {
      planId: value.planId,
      actorBindingDigest: ACTOR_A
    })).resolves.toEqual({ binding: value, expiresAt: 1_500 });
  });

  it("maps generic token-store failures to the agent-test error contract", () => {
    expect(() => new MemoryStudioAgentTestConfirmations({ maxEntries: 0 }))
      .toThrowError(expect.objectContaining({
        code: "studio_agent_test_config_invalid"
      }));
  });
});
