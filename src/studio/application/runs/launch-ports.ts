import type {
  StudioRunDispatchReceipt,
  StudioRunExecutionSnapshot,
  StudioRunPlanRequest,
  StudioRunPlanResolution
} from "../../contracts/run-launch.js";

export type StudioResolvedRunPlan<DispatchPayload> = {
  readonly resolution: StudioRunPlanResolution;
  /**
   * Pinned content or an opaque immutable handle. Every execution-relevant
   * dependency must be represented by the resolution fingerprints.
   */
  readonly dispatchPayload: DispatchPayload;
};

/**
 * Resolves canonical runtime inputs without producing external side effects.
 * It is called once for preview and again immediately before dispatch.
 */
export interface StudioRunPlanResolverPort<DispatchPayload> {
  resolve(
    request: StudioRunPlanRequest,
    signal?: AbortSignal
  ): Promise<StudioResolvedRunPlan<DispatchPayload>>;
}

export type StudioRunConfirmationBinding = {
  readonly planId: string;
  readonly actorBindingDigest: string;
  readonly requestDigest: string;
  readonly executionSnapshotHash: string;
  readonly planDigest: string;
  readonly confirmationRequired: boolean;
  readonly request: StudioRunPlanRequest;
};

export type StudioRunConfirmationRecord = {
  readonly tokenDigest: string;
  readonly expiresAt: number;
  readonly binding: StudioRunConfirmationBinding;
};

export type StudioRunConfirmationConsumeExpectation = {
  readonly planId: string;
  readonly actorBindingDigest: string;
};

export interface StudioRunConfirmationPort {
  issue(
    binding: StudioRunConfirmationBinding,
    options: { readonly ttlMs: number }
  ): Promise<{ readonly token: string; readonly expiresAt: number }>;
  /**
   * Atomically verifies expiry and the expected binding, then marks the token
   * consumed before returning it. Binding mismatches must not consume it.
   */
  consume(
    token: string,
    expected: StudioRunConfirmationConsumeExpectation
  ): Promise<StudioRunConfirmationRecord | undefined>;
}

export type StudioRunDispatchConfirmation = {
  readonly kind: "local_explicit";
  readonly actorId: string;
  readonly actorBindingDigest: string;
  readonly requestId: string;
  readonly confirmedAt: string;
  readonly realRunConfirmed: true;
  readonly listedEffectsConfirmed: true;
  readonly confirmationRequired: boolean;
};

export type StudioRunDispatchCommand<DispatchPayload> = {
  readonly planId: string;
  readonly requestedAt: string;
  readonly idempotencyKeyDigest: string;
  readonly snapshot: StudioRunExecutionSnapshot;
  readonly request: StudioRunPlanRequest;
  readonly resolution: StudioRunPlanResolution;
  readonly dispatchPayload: DispatchPayload;
  readonly confirmation: StudioRunDispatchConfirmation;
};

/**
 * `accepted: true` means the command and a preallocated queued run were
 * durably accepted. The port owns run-id allocation and idempotency for the
 * combination of `idempotencyKeyDigest`, actor binding, and execution
 * snapshot. It must execute the pinned payload rather than reread mutable
 * project sources after acceptance.
 */
export interface StudioRunDispatcherPort<DispatchPayload> {
  dispatch(
    command: StudioRunDispatchCommand<DispatchPayload>
  ): Promise<StudioRunDispatchReceipt>;
}
