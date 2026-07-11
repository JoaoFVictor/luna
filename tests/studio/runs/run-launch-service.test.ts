import { describe, expect, it } from "vitest";
import { MemoryStudioRunConfirmations } from "../../../src/studio/adapters/memory/run-confirmations.js";
import {
  studioRunSecretDigest,
  studioRunValueDigest
} from "../../../src/studio/application/runs/launch-digests.js";
import type {
  StudioRunDispatchCommand,
  StudioRunDispatcherPort,
  StudioRunPlanResolverPort
} from "../../../src/studio/application/runs/launch-ports.js";
import { StudioRunLaunchService } from "../../../src/studio/application/runs/launch-service.js";
import { studioRunLaunchError } from "../../../src/studio/application/runs/launch-errors.js";
import {
  STUDIO_RUN_LAUNCH_LIMITS,
  type StudioRunDispatchReceipt,
  type StudioRunLaunchContext,
  type StudioRunPlanRequest,
  type StudioRunPlanResolution
} from "../../../src/studio/contracts/run-launch.js";

type DispatchPayload = { readonly generation: number };

const BASE_TIME = Date.parse("2026-07-10T12:00:00.000Z");

function digest(label: string): string {
  return studioRunValueDigest({ label });
}

function request(): StudioRunPlanRequest {
  return {
    workflow_id: "code-review",
    execution_scope: { kind: "workflow" },
    invocation: {
      version: "2026-06",
      source: "github",
      event: "pull_request",
      action: "opened",
      target: { type: "workflow", id: "code-review" },
      repository: { provider: "github", owner: "acme", name: "rocket" },
      payload: { pull_request_number: 42 }
    },
    config: { publish: true, review_depth: 3 },
    input_provenance: {
      kind: "adapter",
      adapter_id: "github-pr-url",
      adapter_input_hash: digest("adapter-input")
    },
    repository_id: "acme-rocket"
  };
}

function context(
  actorId = "local-user",
  actorBinding = "session-binding-actor-a"
): StudioRunLaunchContext {
  return {
    actor_id: actorId,
    actor_binding: actorBinding,
    request_id: `request-${actorId}`
  };
}

function resolution(
  overrides: Partial<StudioRunPlanResolution> = {}
): StudioRunPlanResolution {
  return {
    workflow_id: "code-review",
    mode: "trusted_local_write",
    workflow_revision: digest("workflow-v1"),
    definition_bundle_hash: digest("definition-bundle-v1"),
    catalog_fingerprint: digest("catalog-v1"),
    repository: {
      required: true,
      repository_id: "acme-rocket",
      fingerprint: digest("repository-v1")
    },
    potential_effects: [
      {
        effect_id: "publish-review",
        category: "external_write",
        description: "Publish a pull request review",
        confirmation_required: true,
        operation_id: "pull-request-review.publish",
        policy_id: "github.review.write",
        registration_id: "pull-request-review.publish",
        node_id: "publish"
      },
      {
        effect_id: "model-analysis",
        category: "model_call",
        description: "Call the configured review model",
        confirmation_required: false,
        node_id: "review"
      }
    ],
    resolved_effects: [
      {
        effect_id: "publish-review.github",
        potential_effect_id: "publish-review",
        category: "external_write",
        description: "Publish a GitHub pull request review",
        confirmation_required: true,
        resolution_source: "invocation",
        operation_id: "pull-request-review.publish",
        policy_id: "github.review.write",
        registration_id: "pull-request-review.publish",
        node_id: "publish",
        provider_id: "github"
      }
    ],
    effect_uncertainties: [
      {
        uncertainty_id: "agent-tool-choice",
        kind: "dynamic_agent_tools",
        description: "The agent can choose among its declared read tools",
        may_include_unlisted_write: false,
        node_id: "review"
      }
    ],
    warnings: [
      {
        code: "host-local-execution",
        message: "The run executes on this host"
      }
    ],
    ...overrides,
    execution_scope: overrides.execution_scope ?? { kind: "workflow" }
  };
}

const EXECUTE_REQUEST = (token: string) => ({
  confirmation_token: token,
  idempotency_key: "launch-request-0001",
  confirmation: {
    kind: "local_explicit" as const,
    real_run_confirmed: true as const,
    listed_effects_confirmed: true as const
  }
});

function createFixture(options: {
  readonly resolve?: (generation: number) => StudioRunPlanResolution;
  readonly dispatch?: (
    command: StudioRunDispatchCommand<DispatchPayload>
  ) => Promise<StudioRunDispatchReceipt>;
  readonly ttlMs?: number;
} = {}) {
  let now = BASE_TIME;
  let generation = 0;
  let planSequence = 0;
  const commands: StudioRunDispatchCommand<DispatchPayload>[] = [];
  const resolver: StudioRunPlanResolverPort<DispatchPayload> = {
    resolve: async () => {
      generation += 1;
      return {
        resolution: options.resolve?.(generation) ?? resolution(),
        dispatchPayload: { generation }
      };
    }
  };
  const dispatcher: StudioRunDispatcherPort<DispatchPayload> = {
    dispatch: async (command) => {
      commands.push(command);
      if (options.dispatch !== undefined) {
        return await options.dispatch(command);
      }
      return {
        accepted: true,
        dispatch_status: "queued",
        run_id: `run-${command.dispatchPayload.generation}`,
        plan_id: command.planId,
        execution_snapshot_hash: command.snapshot.execution_snapshot_hash,
        accepted_at: new Date(now).toISOString()
      };
    }
  };
  const confirmations = new MemoryStudioRunConfirmations({ now: () => now });
  const service = new StudioRunLaunchService({
    resolver,
    confirmations,
    dispatcher,
    confirmationTtlMs: options.ttlMs ?? 60_000,
    now: () => now,
    createPlanId: () => {
      planSequence += 1;
      return `rp_${String(planSequence).padStart(32, "0")}`;
    }
  });
  return {
    service,
    commands,
    generation: () => generation,
    setNow(value: number) {
      now = value;
    }
  };
}

describe("StudioRunLaunchService", () => {
  it("returns an immutable plan pinned to all execution fingerprints", async () => {
    const fixture = createFixture();
    const mutableRequest = request();
    const plan = await fixture.service.plan(mutableRequest, context());

    expect(plan).toMatchObject({
      workflow_id: "code-review",
      mode: "trusted_local_write",
      workflow_revision: digest("workflow-v1"),
      definition_bundle_hash: digest("definition-bundle-v1"),
      catalog_fingerprint: digest("catalog-v1"),
      repository_required: true,
      repository_id: "acme-rocket",
      repository_fingerprint: digest("repository-v1"),
      confirmation_required: true,
      input_provenance: {
        kind: "adapter",
        adapter_id: "github-pr-url",
        adapter_input_hash: digest("adapter-input")
      }
    });
    expect(plan.invocation_hash).toBe(
      studioRunValueDigest(mutableRequest.invocation)
    );
    expect(plan.config_hash).toBe(studioRunValueDigest(mutableRequest.config));
    expect(plan.execution_snapshot_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.potential_effects)).toBe(true);
    expect(Object.isFrozen(plan.potential_effects[0])).toBe(true);

    const config = mutableRequest.config as { publish: boolean };
    config.publish = false;
    await fixture.service.execute(
      plan.plan_id,
      EXECUTE_REQUEST(plan.confirmation_token),
      context()
    );
    expect(fixture.commands[0]?.request.config).toEqual({
      publish: true,
      review_depth: 3
    });
  });

  it("re-resolves the plan and asynchronously dispatches a preallocated run id", async () => {
    const fixture = createFixture();
    const plan = await fixture.service.plan(request(), context());
    const receipt = await fixture.service.execute(
      plan.plan_id,
      EXECUTE_REQUEST(plan.confirmation_token),
      context()
    );

    expect(receipt).toEqual({
      accepted: true,
      dispatch_status: "queued",
      run_id: "run-2",
      plan_id: plan.plan_id,
      execution_snapshot_hash: plan.execution_snapshot_hash,
      accepted_at: "2026-07-10T12:00:00.000Z"
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(fixture.generation()).toBe(2);
    expect(fixture.commands).toHaveLength(1);
    expect(Object.isFrozen(fixture.commands[0])).toBe(true);
    expect(Object.isFrozen(fixture.commands[0]?.confirmation)).toBe(true);
    expect(JSON.stringify(fixture.commands[0])).not.toContain(
      plan.confirmation_token
    );
    expect(JSON.stringify(receipt)).not.toContain(plan.confirmation_token);
    expect(fixture.commands[0]).toMatchObject({
      planId: plan.plan_id,
      dispatchPayload: { generation: 2 },
      idempotencyKeyDigest: studioRunSecretDigest("launch-request-0001"),
      confirmation: {
        actorId: "local-user",
        actorBindingDigest: studioRunSecretDigest("session-binding-actor-a"),
        requestId: "request-local-user",
        realRunConfirmed: true,
        listedEffectsConfirmed: true,
        confirmationRequired: true
      }
    });
  });

  it("allows the dispatcher to adopt an idempotently accepted run", async () => {
    const acceptedRunByKey = new Map<string, string>();
    const fixture = createFixture({
      dispatch: async (command) => {
        const runId = acceptedRunByKey.get(command.idempotencyKeyDigest) ??
          "durable-run-1";
        acceptedRunByKey.set(command.idempotencyKeyDigest, runId);
        return {
          accepted: true,
          dispatch_status: "queued",
          run_id: runId,
          plan_id: command.planId,
          execution_snapshot_hash: command.snapshot.execution_snapshot_hash,
          accepted_at: "2026-07-10T12:00:00.000Z"
        };
      }
    });
    const firstPlan = await fixture.service.plan(request(), context());
    const first = await fixture.service.execute(
      firstPlan.plan_id,
      EXECUTE_REQUEST(firstPlan.confirmation_token),
      context()
    );
    fixture.setNow(BASE_TIME + 30_000);
    const retryPlan = await fixture.service.plan(request(), context());
    const adopted = await fixture.service.execute(
      retryPlan.plan_id,
      EXECUTE_REQUEST(retryPlan.confirmation_token),
      context()
    );

    expect(first.run_id).toBe("durable-run-1");
    expect(adopted.run_id).toBe(first.run_id);
    expect(fixture.commands).toHaveLength(2);
  });

  it("rejects an expired confirmation without dispatching", async () => {
    const fixture = createFixture({ ttlMs: 1_000 });
    const plan = await fixture.service.plan(request(), context());
    fixture.setNow(BASE_TIME + 1_000);

    await expect(fixture.service.execute(
      plan.plan_id,
      EXECUTE_REQUEST(plan.confirmation_token),
      context()
    )).rejects.toMatchObject({ code: "studio_run_confirmation_invalid" });
    expect(fixture.commands).toHaveLength(0);
  });

  it("atomically rejects concurrent token replay", async () => {
    const fixture = createFixture();
    const plan = await fixture.service.plan(request(), context());
    const attempts = await Promise.allSettled([
      fixture.service.execute(
        plan.plan_id,
        EXECUTE_REQUEST(plan.confirmation_token),
        context()
      ),
      fixture.service.execute(
        plan.plan_id,
        EXECUTE_REQUEST(plan.confirmation_token),
        context()
      )
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "studio_run_confirmation_invalid" }
    });
    expect(fixture.commands).toHaveLength(1);
  });

  it("binds a token to the actor session without burning it on actor exchange", async () => {
    const fixture = createFixture();
    const plan = await fixture.service.plan(request(), context());

    await expect(fixture.service.execute(
      plan.plan_id,
      EXECUTE_REQUEST(plan.confirmation_token),
      context("other-user", "session-binding-actor-b")
    )).rejects.toMatchObject({ code: "studio_run_confirmation_invalid" });
    await expect(fixture.service.execute(
      plan.plan_id,
      EXECUTE_REQUEST(plan.confirmation_token),
      context()
    )).resolves.toMatchObject({ accepted: true });
    expect(fixture.commands).toHaveLength(1);
  });

  it("binds a token to one plan without burning it on plan exchange", async () => {
    const fixture = createFixture();
    const first = await fixture.service.plan(request(), context());
    const second = await fixture.service.plan(request(), context());

    await expect(fixture.service.execute(
      second.plan_id,
      EXECUTE_REQUEST(first.confirmation_token),
      context()
    )).rejects.toMatchObject({ code: "studio_run_confirmation_invalid" });
    await expect(fixture.service.execute(
      first.plan_id,
      EXECUTE_REQUEST(first.confirmation_token),
      context()
    )).resolves.toMatchObject({ accepted: true });
  });

  it("rejects stale fingerprints before dispatch", async () => {
    const fixture = createFixture({
      resolve: (generation) => resolution({
        catalog_fingerprint: digest(`catalog-v${generation}`)
      })
    });
    const plan = await fixture.service.plan(request(), context());

    await expect(fixture.service.execute(
      plan.plan_id,
      EXECUTE_REQUEST(plan.confirmation_token),
      context()
    )).rejects.toMatchObject({ code: "studio_run_plan_stale" });
    expect(fixture.commands).toHaveLength(0);
  });

  it("binds workflow mode into the execution snapshot and rejects a changed mode", async () => {
    const fixture = createFixture({
      resolve: (generation) => resolution({
        mode: generation === 1 ? "read_only" : "trusted_local_write"
      })
    });
    const plan = await fixture.service.plan(request(), context());
    expect(plan.mode).toBe("read_only");

    await expect(fixture.service.execute(
      plan.plan_id,
      EXECUTE_REQUEST(plan.confirmation_token),
      context()
    )).rejects.toMatchObject({ code: "studio_run_plan_stale" });
    expect(fixture.commands).toHaveLength(0);
  });

  it("rejects a changed effect preview even when execution fingerprints are unchanged", async () => {
    const fixture = createFixture({
      resolve: (generation) => {
        const base = resolution();
        return resolution({
          potential_effects: base.potential_effects.map((effect) =>
            effect.effect_id === "publish-review" && generation === 2
              ? { ...effect, description: "Publish a changed review operation" }
              : effect
          )
        });
      }
    });
    const plan = await fixture.service.plan(request(), context());

    await expect(fixture.service.execute(
      plan.plan_id,
      EXECUTE_REQUEST(plan.confirmation_token),
      context()
    )).rejects.toMatchObject({ code: "studio_run_plan_stale" });
    expect(fixture.commands).toHaveLength(0);
  });

  it("rejects mismatched workflow and repository resolution", async () => {
    const workflowMismatch = createFixture({
      resolve: () => resolution({ workflow_id: "implementation" })
    });
    await expect(workflowMismatch.service.plan(request(), context()))
      .rejects.toMatchObject({ code: "studio_run_plan_resolution_mismatch" });

    const repositoryMismatch = createFixture({
      resolve: () => resolution({
        repository: {
          required: true,
          repository_id: "different-repository",
          fingerprint: digest("different-repository")
        }
      })
    });
    await expect(repositoryMismatch.service.plan(request(), context()))
      .rejects.toMatchObject({ code: "studio_run_plan_resolution_mismatch" });

    const scopeMismatch = createFixture({
      resolve: () => resolution({
        execution_scope: { kind: "through_node", node_id: "review" }
      })
    });
    await expect(scopeMismatch.service.plan(request(), context()))
      .rejects.toMatchObject({ code: "studio_run_plan_resolution_mismatch" });
  });

  it("enforces input depth and effect-count limits before confirmation", async () => {
    const fixture = createFixture();
    let nested: unknown = "leaf";
    for (let depth = 0; depth <= STUDIO_RUN_LAUNCH_LIMITS.config.maxDepth; depth += 1) {
      nested = { nested };
    }
    const oversizedInput = { ...request(), config: nested };
    await expect(fixture.service.plan(oversizedInput, context()))
      .rejects.toMatchObject({ code: "studio_run_plan_invalid" });
    expect(fixture.generation()).toBe(0);

    const tooManyEffects = createFixture({
      resolve: () => resolution({
        potential_effects: Array.from(
          { length: STUDIO_RUN_LAUNCH_LIMITS.maxPotentialEffects + 1 },
          (_, index) => ({
            effect_id: `effect-${index}`,
            category: "model_call" as const,
            description: `Model effect ${index}`,
            confirmation_required: false
          })
        ),
        resolved_effects: []
      })
    });
    await expect(tooManyEffects.service.plan(request(), context()))
      .rejects.toMatchObject({ code: "studio_run_plan_resolution_invalid" });
  });

  it("rejects target confusion and write effects without confirmation", async () => {
    const fixture = createFixture();
    const confusedTarget = request();
    confusedTarget.invocation.target = {
      type: "workflow",
      id: "implementation"
    };
    await expect(fixture.service.plan(confusedTarget, context()))
      .rejects.toMatchObject({ code: "studio_run_plan_invalid" });
    expect(fixture.generation()).toBe(0);

    const unconfirmedWrite = createFixture({
      resolve: () => {
        const base = resolution();
        return resolution({
          potential_effects: base.potential_effects.map((effect) =>
            effect.effect_id === "publish-review"
              ? { ...effect, confirmation_required: false }
              : effect
          ),
          resolved_effects: []
        });
      }
    });
    await expect(unconfirmedWrite.service.plan(request(), context()))
      .rejects.toMatchObject({ code: "studio_run_plan_resolution_invalid" });
  });

  it("rejects a dispatcher receipt that does not bind the accepted command", async () => {
    const fixture = createFixture({
      dispatch: async (command) => ({
        accepted: true,
        dispatch_status: "queued",
        run_id: "durable-existing-run",
        plan_id: `rp_${"9".repeat(32)}`,
        execution_snapshot_hash: command.snapshot.execution_snapshot_hash,
        accepted_at: new Date(BASE_TIME).toISOString()
      })
    });
    const plan = await fixture.service.plan(request(), context());

    await expect(fixture.service.execute(
      plan.plan_id,
      EXECUTE_REQUEST(plan.confirmation_token),
      context()
    )).rejects.toMatchObject({
      code: "studio_run_dispatch_contract_invalid",
      details: {
        plan_id: plan.plan_id,
        acceptance_unknown: true
      }
    });
  });

  it("marks malformed dispatcher receipts as an unknown acceptance", async () => {
    const fixture = createFixture({
      dispatch: async () =>
        ({ accepted: true } as unknown as StudioRunDispatchReceipt)
    });
    const plan = await fixture.service.plan(request(), context());

    await expect(fixture.service.execute(
      plan.plan_id,
      EXECUTE_REQUEST(plan.confirmation_token),
      context()
    )).rejects.toMatchObject({
      code: "studio_run_dispatch_contract_invalid",
      details: {
        plan_id: plan.plan_id,
        acceptance_unknown: true
      }
    });
  });

  it("marks dispatcher domain failures as an unknown acceptance", async () => {
    const fixture = createFixture({
      dispatch: async () => {
        throw studioRunLaunchError(
          "studio_run_dispatch_failed",
          "Dispatcher failed after durable acceptance",
          { dispatcher_state: "unknown" }
        );
      }
    });
    const plan = await fixture.service.plan(request(), context());

    await expect(fixture.service.execute(
      plan.plan_id,
      EXECUTE_REQUEST(plan.confirmation_token),
      context()
    )).rejects.toMatchObject({
      code: "studio_run_dispatch_failed",
      details: {
        plan_id: plan.plan_id,
        dispatcher_state: "unknown",
        acceptance_unknown: true
      }
    });
    await expect(fixture.service.execute(
      plan.plan_id,
      EXECUTE_REQUEST(plan.confirmation_token),
      context()
    )).rejects.toMatchObject({ code: "studio_run_confirmation_invalid" });
    expect(fixture.commands).toHaveLength(1);
  });

  it("does not expose unsupported cancel or replay commands", () => {
    const fixture = createFixture();
    expect("cancel" in fixture.service).toBe(false);
    expect("replay" in fixture.service).toBe(false);
  });
});
