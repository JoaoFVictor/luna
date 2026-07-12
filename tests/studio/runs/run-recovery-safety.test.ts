import { describe, expect, it } from "vitest";
import type { NativeStudioQueuedRun } from "../../../src/studio/adapters/filesystem/run-dispatch-contracts.js";
import { nativeStudioCheckpointReplayIsSafe } from "../../../src/studio/adapters/native/run-recovery-safety.js";

function jobWithSideEffects(
  sideEffects: NativeStudioQueuedRun["preallocation"]["side_effects"]
): NativeStudioQueuedRun {
  return {
    preallocation: { side_effects: sideEffects }
  } as NativeStudioQueuedRun;
}

describe("native Studio checkpoint replay safety", () => {
  it.each(["potential", "resolved"] as const)(
    "never treats a %s model call as automatically replay-safe",
    (stage) => {
      const material = {
        effect_id: "effect-model",
        category: "model_call",
        description: "Invoke a model agent",
        confirmation_required: false,
        retry_semantics: "retry_forbidden" as const,
        idempotency_scope: "attempt" as const,
        registration_id: "reviewer",
        node_id: "review",
        ...(stage === "resolved"
          ? {
              potential_effect_id: "potential-model",
              resolution_source: "preflight" as const
            }
          : {})
      };

      expect(nativeStudioCheckpointReplayIsSafe(jobWithSideEffects([
        { stage, ...material }
      ]))).toBe(false);
    }
  );

  it("still permits a declared non-writing bookkeeping-free read", () => {
    expect(nativeStudioCheckpointReplayIsSafe(jobWithSideEffects([{
      stage: "potential",
      effect_id: "effect-read",
      category: "provider_read",
      description: "Read pinned provider context",
      confirmation_required: false,
      retry_semantics: "replay_safe",
      idempotency_scope: "attempt",
      operation_id: "git.status"
    }]))).toBe(true);
  });

  it("fails closed for a read without explicit replay-safe policy evidence", () => {
    expect(nativeStudioCheckpointReplayIsSafe(jobWithSideEffects([{
      stage: "potential",
      effect_id: "effect-legacy-read",
      category: "other",
      description: "Invoke an extension-owned read",
      confirmation_required: false,
      operation_id: "extension.read"
    }]))).toBe(false);
  });
});
