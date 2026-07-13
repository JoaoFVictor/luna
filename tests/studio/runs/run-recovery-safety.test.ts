import { describe, expect, it } from "vitest";
import {
  createInitialRuntimeState,
  type LunaRuntimeState
} from "../../../src/core/runtime/state.js";
import type { NativeStudioQueuedRun } from "../../../src/studio/adapters/filesystem/run-dispatch-contracts.js";
import {
  nativeStudioActiveResumeReplayIsSafe,
  nativeStudioCheckpointReplayIsSafe,
  nativeStudioFailedTerminalIsSafeForRuntimeState
} from "../../../src/studio/adapters/native/run-recovery-safety.js";

function jobWithSideEffects(
  sideEffects: NativeStudioQueuedRun["preallocation"]["side_effects"]
): NativeStudioQueuedRun {
  return {
    preallocation: { side_effects: sideEffects }
  } as NativeStudioQueuedRun;
}

function failedState(
  nodeStatuses: LunaRuntimeState["node_statuses"]
): LunaRuntimeState {
  return {
    ...createInitialRuntimeState({
      invocation: {},
      config: {},
      run: {
        run_id: "run-resume-1",
        workflow_id: "social-post",
        attempt: 1,
        started_at: "2026-07-12T12:00:00.000Z"
      },
      workflow: { id: "social-post" }
    }),
    run_status: "failed",
    node_statuses: nodeStatuses
  };
}

const imageGenerationEffect = {
  stage: "potential" as const,
  effect_id: "effect-generate-image",
  category: "model_call" as const,
  description: "Generate the proposed image",
  confirmation_required: false,
  retry_semantics: "retry_forbidden" as const,
  idempotency_scope: "attempt" as const,
  node_id: "generate_image"
};

const publishEffect = {
  stage: "potential" as const,
  effect_id: "effect-publish",
  category: "external_write" as const,
  description: "Publish the approved social post",
  confirmation_required: true,
  retry_semantics: "retry_requires_adoption" as const,
  idempotency_scope: "external_resource" as const,
  node_id: "publish_post"
};

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

describe("native Studio active resume replay safety", () => {
  it("allows recovery before any resumed node starts", () => {
    expect(nativeStudioActiveResumeReplayIsSafe({
      sideEffects: [imageGenerationEffect, publishEffect],
      activeNodeIds: [],
      lifecycleProjection: "exact"
    })).toBe(true);
  });

  it("never replays a started external publish", () => {
    expect(nativeStudioActiveResumeReplayIsSafe({
      sideEffects: [imageGenerationEffect, publishEffect],
      activeNodeIds: ["publish_post"],
      lifecycleProjection: "exact"
    })).toBe(false);
  });

  it("maps a durable loop execution id to its logical unsafe node", () => {
    expect(nativeStudioActiveResumeReplayIsSafe({
      sideEffects: [{ ...publishEffect, node_id: "review_loop/publish_post" }],
      activeNodeIds: ["review_loop:iteration-12:publish_post"],
      lifecycleProjection: "exact"
    })).toBe(false);
  });

  it("does not collide a top-level node with an identically named loop body node", () => {
    expect(nativeStudioActiveResumeReplayIsSafe({
      sideEffects: [publishEffect],
      activeNodeIds: ["review_loop:iteration-12:publish_post"],
      lifecycleProjection: "exact"
    })).toBe(true);
  });

  it("fails closed when lifecycle evidence is degraded", () => {
    expect(nativeStudioActiveResumeReplayIsSafe({
      sideEffects: [publishEffect],
      activeNodeIds: [],
      lifecycleProjection: "degraded"
    })).toBe(false);
  });
});

describe("native Studio failed resume safety", () => {
  it("records a known failure when a later write node was never reached", () => {
    expect(nativeStudioFailedTerminalIsSafeForRuntimeState(
      [imageGenerationEffect, publishEffect],
      failedState({
        generate_image: { status: "failed", attempt: 1 },
        publish_post: { status: "skipped_dependency_failed" }
      })
    )).toBe(true);
  });

  it("keeps the outcome unknown when the write node may have run", () => {
    expect(nativeStudioFailedTerminalIsSafeForRuntimeState(
      [imageGenerationEffect, publishEffect],
      failedState({
        generate_image: { status: "succeeded", attempt: 1 },
        publish_post: { status: "failed", attempt: 1 }
      })
    )).toBe(false);
  });

  it("fails closed when a future write has no node identity", () => {
    const { node_id: _nodeId, ...unscopedPublishEffect } = publishEffect;
    expect(nativeStudioFailedTerminalIsSafeForRuntimeState(
      [imageGenerationEffect, unscopedPublishEffect],
      failedState({
        generate_image: { status: "failed", attempt: 1 },
        publish_post: { status: "skipped_dependency_failed" }
      })
    )).toBe(false);
  });
});
