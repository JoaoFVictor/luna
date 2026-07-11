import { randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  AgentRuntimeError,
  type AgentRuntimeUsage,
  type RunAgentOutput
} from "../../../core/agent-runtime/contracts.js";
import {
  StudioAgentTestExecuteRequestSchema,
  StudioAgentTestLaunchContextSchema,
  StudioAgentTestPlanIdSchema,
  StudioAgentTestPlanRequestSchema,
  StudioAgentTestPlanSchema,
  StudioAgentTestResolutionSchema,
  StudioAgentTestResultSchema,
  StudioAgentTestUsageSchema,
  type StudioAgentTestLaunchContext,
  type StudioAgentTestPlan,
  type StudioAgentTestResult
} from "../../contracts/agent-test-bench.js";
import {
  studioAgentTestSecretDigest,
  studioAgentTestValueDigest
} from "./test-bench-digests.js";
import {
  createStudioPlanConfirmationAuthority,
  type StudioPlanConfirmationAuthorityHelper
} from "../confirmations/plan-confirmation-authority.js";
import {
  StudioAgentTestError,
  studioAgentTestError,
  type StudioAgentTestErrorCode
} from "./test-bench-errors.js";
import {
  freezeStudioAgentTestValue,
  studioAgentTestSnapshotHash
} from "./test-bench-plan.js";
import type {
  StudioAgentTestConfirmationBinding,
  StudioAgentTestConfirmationPort,
  StudioAgentTestConfirmationRecord,
  StudioAgentTestResolverPort,
  StudioAgentTestRunnerPort
} from "./test-bench-ports.js";

const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const MAX_CONFIRMATION_TTL_MS = 15 * 60 * 1_000;

export type StudioAgentTestBenchServiceOptions<ExecutionPayload> = {
  readonly resolver: StudioAgentTestResolverPort<ExecutionPayload>;
  readonly confirmations: StudioAgentTestConfirmationPort;
  readonly runner: StudioAgentTestRunnerPort<ExecutionPayload>;
  readonly confirmationTtlMs?: number;
  readonly now?: () => number;
  readonly createPlanId?: () => string;
};

function parseContract<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown,
  code: StudioAgentTestErrorCode,
  message: string
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw studioAgentTestError(code, message);
  }
  return parsed.data;
}

function timestamp(milliseconds: number): string {
  try {
    return new Date(milliseconds).toISOString();
  } catch (cause) {
    throw studioAgentTestError(
      "studio_agent_test_config_invalid",
      "Agent test clock is outside the supported range",
      {},
      { cause }
    );
  }
}

function optionalUsage(
  usage: AgentRuntimeUsage | undefined
): z.output<typeof StudioAgentTestUsageSchema> | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const projected = StudioAgentTestUsageSchema.safeParse({
    ...(usage.input_tokens === undefined
      ? {}
      : { input_tokens: usage.input_tokens }),
    ...(usage.output_tokens === undefined
      ? {}
      : { output_tokens: usage.output_tokens }),
    ...(usage.total_tokens === undefined
      ? {}
      : { total_tokens: usage.total_tokens }),
    ...(usage.cache_read_tokens === undefined
      ? {}
      : { cache_read_tokens: usage.cache_read_tokens }),
    ...(usage.cache_write_tokens === undefined
      ? {}
      : { cache_write_tokens: usage.cache_write_tokens }),
    ...(usage.cost === undefined
      ? {}
      : {
          cost: {
            ...(usage.cost.input === undefined
              ? {}
              : { input: usage.cost.input }),
            ...(usage.cost.output === undefined
              ? {}
              : { output: usage.cost.output }),
            ...(usage.cost.cache_read === undefined
              ? {}
              : { cache_read: usage.cost.cache_read }),
            ...(usage.cost.cache_write === undefined
              ? {}
              : { cache_write: usage.cost.cache_write }),
            ...(usage.cost.total === undefined
              ? {}
              : { total: usage.cost.total }),
            ...(usage.cost.unit === undefined
              ? {}
              : { unit: usage.cost.unit })
          }
        })
  });
  return projected.success ? projected.data : undefined;
}

function optionalRuntimeMetadata(
  metadata: RunAgentOutput["runtime_metadata"]
): Record<string, unknown> | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const parsed = StudioAgentTestResultSchema.shape.runtime_metadata.safeParse(
    metadata
  );
  return parsed.success ? parsed.data : undefined;
}

function runtimeFailure(cause: unknown, planId: string): StudioAgentTestError {
  if (
    cause instanceof AgentRuntimeError &&
    cause.code === "runtime_output_schema_invalid"
  ) {
    return studioAgentTestError(
      "studio_agent_test_output_invalid",
      "The model response did not match the agent output schema",
      { plan_id: planId },
      { cause }
    );
  }
  const outcomeUnknown =
    !(cause instanceof AgentRuntimeError) ||
    cause.code === "runtime_provider_unavailable" ||
    cause.code === "runtime_cancelled" ||
    cause.code === "runtime_unknown_failure";
  return studioAgentTestError(
    outcomeUnknown
      ? "studio_agent_test_outcome_unknown"
      : "studio_agent_test_runtime_failed",
    outcomeUnknown
      ? "The real model call outcome could not be verified"
      : "The agent runtime rejected the smoke test",
    { plan_id: planId, outcome_unknown: outcomeUnknown },
    { cause }
  );
}

export class StudioAgentTestBenchService<ExecutionPayload> {
  readonly #resolver: StudioAgentTestResolverPort<ExecutionPayload>;
  readonly #confirmations: StudioPlanConfirmationAuthorityHelper<
    StudioAgentTestConfirmationBinding,
    StudioAgentTestConfirmationRecord
  >;
  readonly #runner: StudioAgentTestRunnerPort<ExecutionPayload>;
  readonly #confirmationTtlMs: number;
  readonly #now: () => number;
  readonly #createPlanId: () => string;

  constructor(options: StudioAgentTestBenchServiceOptions<ExecutionPayload>) {
    this.#resolver = options.resolver;
    this.#confirmations = createStudioPlanConfirmationAuthority({
      confirmations: options.confirmations,
      snapshotDigestOf: (binding: StudioAgentTestConfirmationBinding) =>
        binding.snapshotHash,
      invalidAuthorityError: () => studioAgentTestError(
        "studio_agent_test_config_invalid",
        "Agent test confirmation authority is invalid"
      )
    });
    this.#runner = options.runner;
    this.#confirmationTtlMs =
      options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#createPlanId = options.createPlanId ?? (() =>
      `atp_${randomBytes(24).toString("base64url")}`
    );
    if (
      !Number.isSafeInteger(this.#confirmationTtlMs) ||
      this.#confirmationTtlMs < 1 ||
      this.#confirmationTtlMs > MAX_CONFIRMATION_TTL_MS
    ) {
      throw studioAgentTestError(
        "studio_agent_test_config_invalid",
        "Agent test confirmation TTL must be between 1ms and 15 minutes"
      );
    }
  }

  async plan(
    input: unknown,
    launchContext: StudioAgentTestLaunchContext,
    signal?: AbortSignal
  ): Promise<StudioAgentTestPlan> {
    const request = freezeStudioAgentTestValue(parseContract(
      StudioAgentTestPlanRequestSchema,
      input,
      "studio_agent_test_request_invalid",
      "Agent test plan request is invalid"
    ));
    const context = parseContract(
      StudioAgentTestLaunchContextSchema,
      launchContext,
      "studio_agent_test_request_invalid",
      "Agent test launch context is invalid"
    );
    const resolved = await this.#resolver.resolve(request, signal);
    const resolution = freezeStudioAgentTestValue(parseContract(
      StudioAgentTestResolutionSchema,
      resolved.resolution,
      "studio_agent_test_target_invalid",
      "Agent test resolution is invalid"
    ));
    const snapshotHash = studioAgentTestSnapshotHash(request, resolution);
    const planId = parseContract(
      StudioAgentTestPlanIdSchema,
      this.#createPlanId(),
      "studio_agent_test_config_invalid",
      "Agent test plan id generator returned an invalid id"
    );
    const createdAt = this.#currentTime();
    const defaultExpiry = createdAt + this.#confirmationTtlMs;
    timestamp(createdAt);
    timestamp(defaultExpiry);

    let execution: StudioAgentTestPlan["execution"];
    let expiresAt = defaultExpiry;
    if (resolution.blockers.length > 0) {
      execution = {
        available: false,
        blockers: resolution.blockers
      };
    } else {
      const binding: StudioAgentTestConfirmationBinding =
        freezeStudioAgentTestValue({
          planId,
          actorBindingDigest: studioAgentTestSecretDigest(
            context.actor_binding
          ),
          requestDigest: studioAgentTestValueDigest(request),
          snapshotHash,
          request
        });
      const issued = await this.#confirmations.issue(binding, {
        ttlMs: this.#confirmationTtlMs
      });
      if (
        !Number.isSafeInteger(issued.expiresAt) ||
        issued.expiresAt <= createdAt
      ) {
        throw studioAgentTestError(
          "studio_agent_test_config_invalid",
          "Agent test confirmation store returned an invalid expiry"
        );
      }
      expiresAt = issued.expiresAt;
      execution = {
        available: true,
        confirmation_required: true,
        confirmation_token: issued.token
      };
    }

    return freezeStudioAgentTestValue(parseContract(
      StudioAgentTestPlanSchema,
      {
        plan_id: planId,
        created_at: timestamp(createdAt),
        expires_at: timestamp(expiresAt),
        snapshot_hash: snapshotHash,
        fixture_hash: studioAgentTestValueDigest(request.fixture),
        context_hash: studioAgentTestValueDigest(request.context),
        resolution,
        execution
      },
      "studio_agent_test_target_invalid",
      "Agent test plan projection is invalid"
    ));
  }

  async execute(
    planIdInput: string,
    input: unknown,
    launchContext: StudioAgentTestLaunchContext,
    signal?: AbortSignal
  ): Promise<StudioAgentTestResult> {
    const planId = parseContract(
      StudioAgentTestPlanIdSchema,
      planIdInput,
      "studio_agent_test_request_invalid",
      "Agent test plan id is invalid"
    );
    const request = parseContract(
      StudioAgentTestExecuteRequestSchema,
      input,
      "studio_agent_test_request_invalid",
      "Agent test execution request is invalid"
    );
    const context = parseContract(
      StudioAgentTestLaunchContextSchema,
      launchContext,
      "studio_agent_test_request_invalid",
      "Agent test launch context is invalid"
    );
    const now = this.#currentTime();
    const actorBindingDigest = studioAgentTestSecretDigest(
      context.actor_binding
    );
    const confirmation = await this.#confirmations.consume(
      request.confirmation_token,
      { planId, actorBindingDigest }
    );
    if (confirmation === undefined || confirmation.expiresAt <= now) {
      throw studioAgentTestError(
        "studio_agent_test_confirmation_invalid",
        "Agent test confirmation is invalid, expired, or already used"
      );
    }
    const binding = confirmation.binding;
    const confirmedRequest = freezeStudioAgentTestValue(parseContract(
      StudioAgentTestPlanRequestSchema,
      binding.request,
      "studio_agent_test_confirmation_invalid",
      "Agent test confirmation binding is invalid"
    ));
    if (
      !this.#confirmations.verify(binding, {
        planId,
        actorBindingDigest,
        requestDigest: studioAgentTestValueDigest(confirmedRequest),
        snapshotDigest: binding.snapshotHash
      })
    ) {
      throw studioAgentTestError(
        "studio_agent_test_confirmation_invalid",
        "Agent test confirmation binding is invalid"
      );
    }

    const resolved = await this.#resolver.resolve(confirmedRequest, signal);
    const resolution = freezeStudioAgentTestValue(parseContract(
      StudioAgentTestResolutionSchema,
      resolved.resolution,
      "studio_agent_test_target_invalid",
      "Agent test resolution is invalid"
    ));
    const currentSnapshotHash = studioAgentTestSnapshotHash(
      confirmedRequest,
      resolution
    );
    if (
      !this.#confirmations.verify(binding, {
        planId,
        actorBindingDigest,
        requestDigest: studioAgentTestValueDigest(confirmedRequest),
        snapshotDigest: currentSnapshotHash
      })
    ) {
      throw studioAgentTestError(
        "studio_agent_test_plan_stale",
        "Agent, draft, model profiles, runtime, or permissions changed after planning",
        { plan_id: planId }
      );
    }
    if (resolution.blockers.length > 0) {
      throw studioAgentTestError(
        "studio_agent_test_execution_blocked",
        "Agent smoke execution is blocked by the current safety policy",
        { plan_id: planId }
      );
    }

    let output: RunAgentOutput;
    try {
      output = await this.#runner.run({
        planId,
        snapshotHash: currentSnapshotHash,
        requestedAt: timestamp(now),
        requestId: context.request_id,
        request: confirmedRequest,
        resolution,
        executionPayload: resolved.executionPayload,
        ...(signal === undefined ? {} : { signal })
      });
    } catch (cause) {
      throw runtimeFailure(cause, planId);
    }

    try {
      const usage = optionalUsage(output.usage);
      const runtimeMetadata = optionalRuntimeMetadata(
        output.runtime_metadata
      );
      return freezeStudioAgentTestValue(StudioAgentTestResultSchema.parse({
        plan_id: planId,
        snapshot_hash: currentSnapshotHash,
        completed_at: timestamp(this.#currentTime()),
        output: output.output,
        output_schema_validated: true,
        ...(usage === undefined ? {} : { usage }),
        ...(runtimeMetadata === undefined
          ? {}
          : { runtime_metadata: runtimeMetadata }),
        scope: resolution.scope
      }));
    } catch (cause) {
      throw studioAgentTestError(
        "studio_agent_test_output_invalid",
        "Agent test result is not safe to return through Studio",
        { plan_id: planId },
        { cause }
      );
    }
  }

  #currentTime(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw studioAgentTestError(
        "studio_agent_test_config_invalid",
        "Agent test clock must return a non-negative safe integer"
      );
    }
    return value;
  }
}
