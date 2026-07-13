import {
  StudioRunEffectUncertaintySchema,
  StudioRunPotentialEffectSchema,
  StudioRunResolvedEffectSchema
} from "../../contracts/run-launch-effects.js";
import type { JsonValue } from "../../../core/runtime/json.js";
import type { LunaRuntimeState } from "../../../core/runtime/state.js";
import type { NativeStudioQueuedRun } from "../filesystem/run-dispatch-contracts.js";

function stagedEffect(value: unknown): {
  readonly stage: unknown;
  readonly material: Record<string, unknown>;
} | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const { stage, ...material } = value as Record<string, unknown>;
  return { stage, material };
}

function effectAllowsAutomaticReplay(effect: {
  readonly category: string;
  readonly confirmation_required: boolean;
  readonly retry_semantics?: string;
}): boolean {
  // Confirmation answers whether a user must approve the original launch; it
  // is not an idempotency guarantee. A model response is external, billable,
  // and nondeterministic, so an uncertain checkpoint must never invoke it a
  // second time automatically.
  return !effect.confirmation_required &&
    effect.category !== "model_call" &&
    effect.retry_semantics === "replay_safe";
}

function effectAllowsFailedTerminal(effect: {
  readonly confirmation_required: boolean;
}): boolean {
  return !effect.confirmation_required;
}

/**
 * A checkpoint acceptance-unknown run may be replayed automatically only when
 * its accepted, immutable preflight proves there are no repository/external
 * writes and no agent/tool uncertainty that could hide one. Unknown legacy
 * effect shapes are deliberately treated as unsafe.
 */
export function nativeStudioCheckpointReplayIsSafe(
  job: NativeStudioQueuedRun
): boolean {
  return nativeStudioEffectsAreSafe(job, effectAllowsAutomaticReplay);
}

/**
 * Classifies a stale running resume from durable pre-execution evidence.
 * The authoritative pre-node journal is persisted before an unsafe executor
 * is entered, so an active unsafe effect may already have reached its external
 * boundary and must never be replayed automatically.
 */
export function nativeStudioActiveResumeReplayIsSafe(input: {
  readonly sideEffects: readonly JsonValue[];
  readonly activeNodeIds: readonly string[];
  readonly lifecycleProjection: "exact" | "degraded" | "unknown";
}): boolean {
  if (input.lifecycleProjection !== "exact") return false;
  const activeNodeIds = new Set(input.activeNodeIds);
  if (activeNodeIds.size === 0) return true;
  return input.sideEffects.every((raw) => {
    const effect = stagedEffect(raw);
    if (effect === undefined) return false;
    if (effect.stage === "potential") {
      const parsed = StudioRunPotentialEffectSchema.safeParse(effect.material);
      return parsed.success && (
        parsed.data.node_id !== undefined && (
          !effectNodeIsActive(activeNodeIds, parsed.data.node_id) ||
          effectAllowsAutomaticReplay(parsed.data)
        )
      );
    }
    if (effect.stage === "resolved") {
      const parsed = StudioRunResolvedEffectSchema.safeParse(effect.material);
      return parsed.success && (
        parsed.data.node_id !== undefined && (
          !effectNodeIsActive(activeNodeIds, parsed.data.node_id) ||
          effectAllowsAutomaticReplay(parsed.data)
        )
      );
    }
    if (effect.stage === "uncertainty") {
      const parsed = StudioRunEffectUncertaintySchema.safeParse(effect.material);
      return parsed.success && (
        parsed.data.node_id !== undefined && (
          !effectNodeIsActive(activeNodeIds, parsed.data.node_id) ||
          !parsed.data.may_include_unlisted_write
        )
      );
    }
    return false;
  });
}

function effectNodeIsActive(
  activeNodeIds: ReadonlySet<string>,
  effectNodeId: string
): boolean {
  for (const activeNodeId of activeNodeIds) {
    if (activeNodeId === effectNodeId) return true;
    // Durable loop executions have physical ids of the form
    // `<loop>:iteration-<n>:<logical-body-node>`. Effect planning uses the
    // composition projection `<loop>/<body-node>` so identically named body
    // nodes in different loops cannot collide. Public ids cannot contain `:`.
    const loopExecution = /^([^:]+):iteration-[1-9][0-9]*:([^:]+)$/u
      .exec(activeNodeId);
    if (loopExecution !== null && effectNodeId === [
      encodeURIComponent(loopExecution[1]!),
      encodeURIComponent(loopExecution[2]!)
    ].join("/")) {
      return true;
    }
  }
  return false;
}

export function nativeStudioResumeNodeReplayIsSafe(
  sideEffects: readonly JsonValue[],
  nodeId: string
): boolean {
  return nativeStudioActiveResumeReplayIsSafe({
    sideEffects,
    activeNodeIds: [nodeId],
    lifecycleProjection: "exact"
  });
}

/**
 * A normal runtime failure is terminal only when the immutable plan excludes
 * confirmed writes. This is intentionally distinct from replay safety: a
 * completed model response can produce a deterministic failed workflow state,
 * while an acceptance-unknown model checkpoint must never bill a second call.
 */
export function nativeStudioFailedTerminalIsSafe(
  job: NativeStudioQueuedRun
): boolean {
  return nativeStudioEffectsAreSafe(job, effectAllowsFailedTerminal);
}

/**
 * A failed runtime state proves which workflow nodes were never reached. This
 * lets interrupt resumption ignore write effects that were still pending (or
 * were skipped) when an earlier node failed, while retaining the dispatcher's
 * conservative classification for every effect whose node may have run.
 */
export function nativeStudioFailedTerminalIsSafeForRuntimeState(
  sideEffects: readonly JsonValue[],
  state: LunaRuntimeState
): boolean {
  return nativeStudioSideEffectsAreSafe(
    sideEffects,
    effectAllowsFailedTerminal,
    state
  );
}

function nativeStudioEffectsAreSafe(
  job: NativeStudioQueuedRun,
  allowsEffect: (effect: {
    readonly category: string;
    readonly confirmation_required: boolean;
    readonly retry_semantics?: string;
  }) => boolean
): boolean {
  return nativeStudioSideEffectsAreSafe(
    job.preallocation.side_effects,
    allowsEffect
  );
}

function nativeStudioSideEffectsAreSafe(
  sideEffects: readonly JsonValue[],
  allowsEffect: (effect: {
    readonly category: string;
    readonly confirmation_required: boolean;
    readonly retry_semantics?: string;
  }) => boolean,
  state?: LunaRuntimeState
): boolean {
  return sideEffects.every((raw) => {
    const effect = stagedEffect(raw);
    if (effect === undefined) {
      return false;
    }
    if (effect.stage === "potential") {
      const parsed = StudioRunPotentialEffectSchema.safeParse(effect.material);
      return parsed.success && (
        effectDefinitelyDidNotRun(state, parsed.data.node_id) ||
        allowsEffect(parsed.data)
      );
    }
    if (effect.stage === "resolved") {
      const parsed = StudioRunResolvedEffectSchema.safeParse(effect.material);
      return parsed.success && (
        effectDefinitelyDidNotRun(state, parsed.data.node_id) ||
        allowsEffect(parsed.data)
      );
    }
    if (effect.stage === "uncertainty") {
      const parsed = StudioRunEffectUncertaintySchema.safeParse(effect.material);
      return parsed.success && (
        effectDefinitelyDidNotRun(state, parsed.data.node_id) ||
        !parsed.data.may_include_unlisted_write
      );
    }
    return false;
  });
}

function effectDefinitelyDidNotRun(
  state: LunaRuntimeState | undefined,
  nodeId: string | undefined
): boolean {
  if (state === undefined || nodeId === undefined) {
    return false;
  }
  const status = state.node_statuses[nodeId]?.status;
  return status === "pending" ||
    status === "skipped_inactive" ||
    status === "skipped_dependency_failed";
}
