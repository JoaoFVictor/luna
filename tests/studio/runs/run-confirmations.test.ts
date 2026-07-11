import { describe, expect, it } from "vitest";
import { MemoryStudioRunConfirmations } from "../../../src/studio/adapters/memory/run-confirmations.js";
import {
  studioRunSecretDigest,
  studioRunValueDigest
} from "../../../src/studio/application/runs/launch-digests.js";
import type { StudioRunConfirmationBinding } from "../../../src/studio/application/runs/launch-ports.js";

const TOKEN = "a".repeat(43);
const ACTOR_A = studioRunSecretDigest("actor-session-a");
const ACTOR_B = studioRunSecretDigest("actor-session-b");

function binding(): StudioRunConfirmationBinding {
  const request = {
    workflow_id: "demo",
    execution_scope: { kind: "workflow" as const },
    invocation: {
      version: "2026-06" as const,
      source: "manual",
      event: "run"
    },
    config: {},
    input_provenance: { kind: "invocation" as const }
  };
  return {
    planId: `rp_${"1".repeat(32)}`,
    actorBindingDigest: ACTOR_A,
    requestDigest: studioRunValueDigest(request),
    executionSnapshotHash: studioRunValueDigest({ snapshot: 1 }),
    planDigest: studioRunValueDigest({ plan: 1 }),
    confirmationRequired: false,
    request
  };
}

describe("MemoryStudioRunConfirmations", () => {
  it("binds consumption to the run plan and actor and returns the run record", async () => {
    const confirmations = new MemoryStudioRunConfirmations({
      now: () => 1_000,
      randomToken: () => TOKEN
    });
    const value = binding();
    const issued = await confirmations.issue(value, { ttlMs: 500 });

    await expect(confirmations.consume(issued.token, {
      planId: value.planId,
      actorBindingDigest: ACTOR_B
    })).resolves.toBeUndefined();
    await expect(confirmations.consume(issued.token, {
      planId: `rp_${"2".repeat(32)}`,
      actorBindingDigest: ACTOR_A
    })).resolves.toBeUndefined();
    await expect(confirmations.consume(issued.token, {
      planId: value.planId,
      actorBindingDigest: ACTOR_A
    })).resolves.toEqual({
      tokenDigest: studioRunSecretDigest(TOKEN),
      expiresAt: 1_500,
      binding: value
    });
  });

  it("maps generic token-store failures to the run-launch error contract", () => {
    expect(() => new MemoryStudioRunConfirmations({ maxEntries: 0 }))
      .toThrowError(expect.objectContaining({
        code: "studio_run_launch_config_invalid"
      }));
  });
});
