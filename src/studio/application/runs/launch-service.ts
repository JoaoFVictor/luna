import { randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  StudioRunDispatchReceiptSchema,
  StudioRunExecuteRequestSchema,
  StudioRunLaunchContextSchema,
  StudioRunPlanIdSchema,
  StudioRunPlanRequestSchema,
  StudioRunPlanResolutionSchema,
  StudioRunPlanSchema,
  type StudioRunDispatchReceipt,
  type StudioRunLaunchContext,
  type StudioRunPlan,
  type StudioRunPlanRequest,
  type StudioRunPlanRequestInput
} from "../../contracts/run-launch.js";
import { studioRunEffectsRequireConfirmation } from "../../contracts/run-launch-effects.js";
import {
  createStudioPlanConfirmationAuthority,
  type StudioPlanConfirmationAuthorityHelper
} from "../confirmations/plan-confirmation-authority.js";
import {
  studioRunDigestsEqual,
  studioRunSecretDigest,
  studioRunValueDigest
} from "./launch-digests.js";
import {
  StudioRunLaunchError,
  studioRunLaunchError,
  type StudioRunLaunchErrorCode
} from "./launch-errors.js";
import {
  assertStudioRunResolutionMatchesRequest,
  createStudioRunExecutionSnapshot,
  freezeStudioRunValue,
  normalizeStudioRunResolution,
  studioRunStablePlanDigest
} from "./launch-plan.js";
import type {
  StudioResolvedRunPlan,
  StudioRunConfirmationBinding,
  StudioRunConfirmationPort,
  StudioRunConfirmationRecord,
  StudioRunDispatchCommand,
  StudioRunDispatchConfirmation,
  StudioRunDispatcherPort,
  StudioRunPlanResolverPort
} from "./launch-ports.js";

const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const MAX_CONFIRMATION_TTL_MS = 15 * 60 * 1_000;

function acceptanceUnknownError(
  cause: unknown,
  planId: string
): StudioRunLaunchError {
  if (cause instanceof StudioRunLaunchError) {
    return studioRunLaunchError(
      cause.code,
      cause.message,
      {
        ...cause.details,
        plan_id: planId,
        acceptance_unknown: true
      },
      { cause }
    );
  }
  return studioRunLaunchError(
    "studio_run_dispatch_failed",
    "Run dispatch did not return a verified acceptance",
    { plan_id: planId, acceptance_unknown: true },
    { cause }
  );
}

export type StudioRunLaunchServiceOptions<DispatchPayload> = {
  readonly resolver: StudioRunPlanResolverPort<DispatchPayload>;
  readonly confirmations: StudioRunConfirmationPort;
  readonly dispatcher: StudioRunDispatcherPort<DispatchPayload>;
  readonly confirmationTtlMs?: number;
  readonly now?: () => number;
  readonly createPlanId?: () => string;
};

function parseContract<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown,
  code: StudioRunLaunchErrorCode,
  message: string
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw studioRunLaunchError(code, message);
  }
  return parsed.data;
}

function isoTimestamp(milliseconds: number): string {
  try {
    return new Date(milliseconds).toISOString();
  } catch (cause) {
    throw studioRunLaunchError(
      "studio_run_launch_config_invalid",
      "Run launch clock is outside the supported date range",
      {},
      { cause }
    );
  }
}

export class StudioRunLaunchService<DispatchPayload> {
  private readonly resolver: StudioRunPlanResolverPort<DispatchPayload>;
  private readonly confirmations: StudioPlanConfirmationAuthorityHelper<
    StudioRunConfirmationBinding,
    StudioRunConfirmationRecord
  >;
  private readonly dispatcher: StudioRunDispatcherPort<DispatchPayload>;
  private readonly confirmationTtlMs: number;
  private readonly now: () => number;
  private readonly createPlanId: () => string;

  constructor(options: StudioRunLaunchServiceOptions<DispatchPayload>) {
    this.resolver = options.resolver;
    this.confirmations = createStudioPlanConfirmationAuthority({
      confirmations: options.confirmations,
      snapshotDigestOf: (binding: StudioRunConfirmationBinding) =>
        binding.planDigest,
      invalidAuthorityError: () => studioRunLaunchError(
        "studio_run_launch_config_invalid",
        "Run confirmation authority is invalid"
      )
    });
    this.dispatcher = options.dispatcher;
    this.confirmationTtlMs =
      options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    this.now = options.now ?? Date.now;
    this.createPlanId = options.createPlanId ?? (() =>
      `rp_${randomBytes(24).toString("base64url")}`
    );

    if (
      !Number.isSafeInteger(this.confirmationTtlMs) ||
      this.confirmationTtlMs < 1 ||
      this.confirmationTtlMs > MAX_CONFIRMATION_TTL_MS
    ) {
      throw studioRunLaunchError(
        "studio_run_launch_config_invalid",
        "Run confirmation TTL must be a positive safe integer no greater than 15 minutes"
      );
    }
  }

  async plan(
    input: StudioRunPlanRequestInput,
    launchContext: StudioRunLaunchContext,
    signal?: AbortSignal
  ): Promise<StudioRunPlan> {
    const request = freezeStudioRunValue(parseContract(
      StudioRunPlanRequestSchema,
      input,
      "studio_run_plan_invalid",
      "Run plan request is invalid"
    ));
    const context = parseContract(
      StudioRunLaunchContextSchema,
      launchContext,
      "studio_run_plan_invalid",
      "Run launch context is invalid"
    );
    const resolved = await this.resolve(request, signal);
    const snapshot = freezeStudioRunValue(
      createStudioRunExecutionSnapshot(request, resolved.resolution)
    );
    const confirmationRequired = studioRunEffectsRequireConfirmation(
      resolved.resolution
    );
    const planDigest = studioRunStablePlanDigest(
      snapshot,
      resolved.resolution,
      confirmationRequired
    );
    const planId = parseContract(
      StudioRunPlanIdSchema,
      this.createPlanId(),
      "studio_run_plan_invalid",
      "Run plan id generator returned an invalid id"
    );
    const createdAt = this.currentTime();
    isoTimestamp(createdAt);
    isoTimestamp(createdAt + this.confirmationTtlMs);
    const binding: StudioRunConfirmationBinding = freezeStudioRunValue({
      planId,
      actorBindingDigest: studioRunSecretDigest(context.actor_binding),
      requestDigest: studioRunValueDigest(request),
      executionSnapshotHash: snapshot.execution_snapshot_hash,
      planDigest,
      confirmationRequired,
      request
    });
    const issued = await this.confirmations.issue(binding, {
      ttlMs: this.confirmationTtlMs
    });
    if (
      !Number.isSafeInteger(issued.expiresAt) ||
      issued.expiresAt <= createdAt
    ) {
      throw studioRunLaunchError(
        "studio_run_launch_config_invalid",
        "Run confirmation store returned an invalid expiry"
      );
    }

    const plan = parseContract(
      StudioRunPlanSchema,
      {
        plan_id: planId,
        created_at: isoTimestamp(createdAt),
        expires_at: isoTimestamp(issued.expiresAt),
        workflow_id: snapshot.workflow_id,
        mode: snapshot.mode,
        workflow_revision: snapshot.workflow_revision,
        definition_bundle_hash: snapshot.definition_bundle_hash,
        catalog_fingerprint: snapshot.catalog_fingerprint,
        execution_snapshot_hash: snapshot.execution_snapshot_hash,
        invocation_hash: snapshot.invocation_hash,
        config_hash: snapshot.config_hash,
        repository_required: snapshot.repository_required,
        ...(snapshot.repository_id === undefined
          ? {}
          : { repository_id: snapshot.repository_id }),
        ...(snapshot.repository_fingerprint === undefined
          ? {}
          : { repository_fingerprint: snapshot.repository_fingerprint }),
        input_provenance: snapshot.input_provenance,
        potential_effects: resolved.resolution.potential_effects,
        resolved_effects: resolved.resolution.resolved_effects,
        effect_uncertainties: resolved.resolution.effect_uncertainties,
        warnings: resolved.resolution.warnings,
        confirmation_required: confirmationRequired,
        confirmation_token: issued.token
      },
      "studio_run_plan_resolution_invalid",
      "Run plan projection is invalid"
    );
    return freezeStudioRunValue(plan);
  }

  async execute(
    planIdInput: string,
    input: unknown,
    launchContext: StudioRunLaunchContext,
    signal?: AbortSignal
  ): Promise<StudioRunDispatchReceipt> {
    const planId = parseContract(
      StudioRunPlanIdSchema,
      planIdInput,
      "studio_run_plan_invalid",
      "Run plan id is invalid"
    );
    const request = parseContract(
      StudioRunExecuteRequestSchema,
      input,
      "studio_run_plan_invalid",
      "Run execution request is invalid"
    );
    const context = parseContract(
      StudioRunLaunchContextSchema,
      launchContext,
      "studio_run_plan_invalid",
      "Run launch context is invalid"
    );
    const actorBindingDigest = studioRunSecretDigest(context.actor_binding);
    const now = this.currentTime();
    const requestedAt = isoTimestamp(now);
    const confirmation = await this.confirmations.consume(
      request.confirmation_token,
      { planId, actorBindingDigest }
    );
    if (confirmation === undefined) {
      throw studioRunLaunchError(
        "studio_run_confirmation_invalid",
        "Run confirmation is invalid, expired, or already used"
      );
    }

    if (confirmation.expiresAt <= now) {
      throw studioRunLaunchError(
        "studio_run_confirmation_invalid",
        "Run confirmation is invalid, expired, or already used"
      );
    }
    const binding = confirmation.binding;
    const confirmedRequest = freezeStudioRunValue(parseContract(
      StudioRunPlanRequestSchema,
      binding.request,
      "studio_run_confirmation_invalid",
      "Run confirmation binding is invalid"
    ));
    if (
      !this.confirmations.verify(binding, {
        planId,
        actorBindingDigest,
        requestDigest: studioRunValueDigest(confirmedRequest),
        snapshotDigest: binding.planDigest
      })
    ) {
      throw studioRunLaunchError(
        "studio_run_confirmation_invalid",
        "Run confirmation binding is invalid"
      );
    }

    const resolved = await this.resolve(confirmedRequest, signal);
    const currentSnapshot = freezeStudioRunValue(
      createStudioRunExecutionSnapshot(confirmedRequest, resolved.resolution)
    );
    const confirmationRequired = studioRunEffectsRequireConfirmation(
      resolved.resolution
    );
    const currentPlanDigest = studioRunStablePlanDigest(
      currentSnapshot,
      resolved.resolution,
      confirmationRequired
    );
    if (
      !this.confirmations.verify(binding, {
        planId,
        actorBindingDigest,
        requestDigest: studioRunValueDigest(confirmedRequest),
        snapshotDigest: currentPlanDigest
      }) ||
      !studioRunDigestsEqual(
        currentSnapshot.execution_snapshot_hash,
        binding.executionSnapshotHash
      ) ||
      confirmationRequired !== binding.confirmationRequired
    ) {
      throw studioRunLaunchError(
        "studio_run_plan_stale",
        "Run plan changed after confirmation and must be planned again",
        { plan_id: planId }
      );
    }

    const dispatchConfirmation: StudioRunDispatchConfirmation =
      freezeStudioRunValue({
        kind: "local_explicit",
        actorId: context.actor_id,
        actorBindingDigest,
        requestId: context.request_id,
        confirmedAt: requestedAt,
        realRunConfirmed: true,
        listedEffectsConfirmed: true,
        confirmationRequired
      });
    const command: StudioRunDispatchCommand<DispatchPayload> = Object.freeze({
      planId,
      requestedAt,
      idempotencyKeyDigest: studioRunSecretDigest(request.idempotency_key),
      snapshot: currentSnapshot,
      request: confirmedRequest,
      resolution: resolved.resolution,
      dispatchPayload: resolved.dispatchPayload,
      confirmation: dispatchConfirmation
    });

    try {
      const rawReceipt: unknown = await this.dispatcher.dispatch(command);
      const receipt = parseContract(
        StudioRunDispatchReceiptSchema,
        rawReceipt,
        "studio_run_dispatch_contract_invalid",
        "Run dispatcher returned an invalid receipt"
      );
      if (
        receipt.plan_id !== planId ||
        !studioRunDigestsEqual(
          receipt.execution_snapshot_hash,
          currentSnapshot.execution_snapshot_hash
        )
      ) {
        throw studioRunLaunchError(
          "studio_run_dispatch_contract_invalid",
          "Run dispatcher receipt does not match the accepted command",
          { plan_id: planId }
        );
      }
      return freezeStudioRunValue(receipt);
    } catch (cause) {
      throw acceptanceUnknownError(cause, planId);
    }
  }

  private async resolve(
    request: StudioRunPlanRequest,
    signal?: AbortSignal
  ): Promise<StudioResolvedRunPlan<DispatchPayload>> {
    signal?.throwIfAborted();
    const result = await this.resolver.resolve(request, signal);
    signal?.throwIfAborted();
    const resolution = normalizeStudioRunResolution(parseContract(
      StudioRunPlanResolutionSchema,
      result.resolution,
      "studio_run_plan_resolution_invalid",
      "Run plan resolution is invalid"
    ));
    assertStudioRunResolutionMatchesRequest(request, resolution);
    return {
      resolution: freezeStudioRunValue(resolution),
      dispatchPayload: result.dispatchPayload
    };
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw studioRunLaunchError(
        "studio_run_launch_config_invalid",
        "Run launch clock must return a non-negative safe integer"
      );
    }
    return value;
  }
}
