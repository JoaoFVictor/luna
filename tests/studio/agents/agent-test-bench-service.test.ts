import { AgentRuntimeError } from "../../../src/core/agent-runtime/contracts.js";
import { describe, expect, it } from "vitest";
import { MemoryStudioAgentTestConfirmations } from "../../../src/studio/adapters/memory/agent-test-confirmations.js";
import { studioAgentTestValueDigest } from "../../../src/studio/application/agents/test-bench-digests.js";
import type {
  StudioAgentTestExecutionCommand,
  StudioAgentTestResolverPort,
  StudioAgentTestRunnerPort
} from "../../../src/studio/application/agents/test-bench-ports.js";
import { StudioAgentTestBenchService } from "../../../src/studio/application/agents/test-bench-service.js";
import type {
  StudioAgentTestLaunchContext,
  StudioAgentTestPlanRequest,
  StudioAgentTestResolution
} from "../../../src/studio/contracts/agent-test-bench.js";

type ExecutionPayload = { readonly generation: number };

const BASE_TIME = Date.parse("2026-07-11T12:00:00.000Z");
const TOKEN = "t".repeat(43);

function digest(label: string): string {
  return studioAgentTestValueDigest({ label });
}

function request(): StudioAgentTestPlanRequest {
  return {
    target: {
      kind: "installed",
      agent_id: "reviewer",
      revision: digest("agent-v1")
    },
    fixture: { pull_request: 42, title: "Bounded fixture" },
    context: {
      kind: "json",
      value: { team_policy: "explicit-only" }
    }
  };
}

function context(
  actorBinding = "local-session-actor-a",
  requestId = "request-agent-test-a"
): StudioAgentTestLaunchContext {
  return {
    actor_binding: actorBinding,
    request_id: requestId
  };
}

function resolution(
  overrides: Partial<StudioAgentTestResolution> = {}
): StudioAgentTestResolution {
  return {
    target: {
      kind: "installed",
      agent_id: "reviewer",
      agent_revision: digest("agent-v1"),
      requested_revision: digest("agent-v1")
    },
    agent_mode: "read_only",
    default_model_profile_id: "standard",
    selected_model_profile: {
      id: "standard",
      model: "openai/gpt-5",
      reasoning_effort: "medium"
    },
    available_model_profiles: [
      {
        id: "standard",
        model: "openai/gpt-5",
        reasoning_effort: "medium"
      }
    ],
    runtime: {
      id: "test-runtime",
      display_name: "Test runtime",
      supported_tool_protocols: ["local"],
      supported_runtime_requirements: ["tool_calling"],
      configuration_hash: digest("runtime-v1")
    },
    tools: [],
    mcp_servers: [],
    subagents: [],
    declared_skills: [],
    declared_agent_context_files: [],
    runtime_requirements: [],
    blockers: [],
    catalog_fingerprint: digest("catalog-v1"),
    output_schema_hash: digest("output-v1"),
    instructions_hash: digest("instructions-v1"),
    scope: {
      real_model_call: true,
      local_tools_executed: false,
      mcp_executed: false,
      subagents_executed: false,
      workflow_context_included: false,
      repository_context_included: false,
      agent_context_files_included: false,
      workflow_equivalent: false,
      statement: "Isolated real-model smoke test; not a workflow execution."
    },
    ...overrides
  };
}

function executeRequest(token: string) {
  return {
    confirmation_token: token,
    confirmation: {
      kind: "local_explicit" as const,
      real_model_call_confirmed: true as const,
      isolated_smoke_scope_confirmed: true as const
    }
  };
}

function createFixture(options: {
  readonly resolve?: (generation: number) => StudioAgentTestResolution;
  readonly run?: (
    command: StudioAgentTestExecutionCommand<ExecutionPayload>
  ) => ReturnType<StudioAgentTestRunnerPort<ExecutionPayload>["run"]>;
  readonly ttlMs?: number;
} = {}) {
  let now = BASE_TIME;
  let generation = 0;
  let planSequence = 0;
  const commands: StudioAgentTestExecutionCommand<ExecutionPayload>[] = [];
  const resolver: StudioAgentTestResolverPort<ExecutionPayload> = {
    resolve: async () => {
      generation += 1;
      return {
        resolution: options.resolve?.(generation) ?? resolution(),
        executionPayload: { generation }
      };
    }
  };
  const runner: StudioAgentTestRunnerPort<ExecutionPayload> = {
    run: async (command) => {
      commands.push(command);
      return options.run === undefined
        ? {
            output: { status: "ok" },
            usage: {
              input_tokens: 12,
              output_tokens: 4,
              total_tokens: 16,
              cost: { total: 0.001, unit: "USD" },
              ignored_provider_field: "not projected"
            },
            runtime_metadata: {
              provider: "fixture",
              request_id: "provider-1"
            }
          }
        : await options.run(command);
    }
  };
  const confirmations = new MemoryStudioAgentTestConfirmations({
    now: () => now,
    createToken: () => TOKEN
  });
  const service = new StudioAgentTestBenchService({
    resolver,
    confirmations,
    runner,
    confirmationTtlMs: options.ttlMs ?? 60_000,
    now: () => now,
    createPlanId: () => {
      planSequence += 1;
      return `atp_${String(planSequence).padStart(32, "0")}`;
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

describe("StudioAgentTestBenchService", () => {
  it("pins a bounded immutable plan and runs only after explicit confirmation", async () => {
    const fixture = createFixture();
    const mutableRequest = request();
    const plan = await fixture.service.plan(mutableRequest, context());

    expect(plan.execution).toEqual({
      available: true,
      confirmation_required: true,
      confirmation_token: TOKEN
    });
    expect(plan.resolution.scope).toMatchObject({
      real_model_call: true,
      local_tools_executed: false,
      mcp_executed: false,
      subagents_executed: false,
      workflow_equivalent: false
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.resolution)).toBe(true);

    mutableRequest.fixture.title = "mutated after planning";
    const result = await fixture.service.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      context()
    );

    expect(result).toMatchObject({
      plan_id: plan.plan_id,
      snapshot_hash: plan.snapshot_hash,
      output: { status: "ok" },
      output_schema_validated: true,
      usage: {
        input_tokens: 12,
        output_tokens: 4,
        total_tokens: 16,
        cost: { total: 0.001, unit: "USD" }
      },
      runtime_metadata: {
        provider: "fixture",
        request_id: "provider-1"
      }
    });
    expect(result.usage).not.toHaveProperty("ignored_provider_field");
    expect(Object.isFrozen(result)).toBe(true);
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]?.request.fixture).toEqual({
      pull_request: 42,
      title: "Bounded fixture"
    });
    expect(fixture.commands[0]).not.toHaveProperty("confirmation_token");
    expect(fixture.generation()).toBe(2);
  });

  it("rejects unknown and oversized request fields before resolving", async () => {
    const fixture = createFixture();

    await expect(fixture.service.plan(
      { ...request(), hidden_context: { repository: "/secret" } },
      context()
    )).rejects.toMatchObject({ code: "studio_agent_test_request_invalid" });
    await expect(fixture.service.plan(
      {
        ...request(),
        fixture: { payload: "x".repeat(256 * 1024) }
      },
      context()
    )).rejects.toMatchObject({ code: "studio_agent_test_request_invalid" });
    expect(fixture.generation()).toBe(0);
  });

  it("returns blockers without issuing an executable confirmation", async () => {
    const blocker = {
      code: "trusted_write_requires_isolation" as const,
      message: "Trusted write smoke tests require proven isolation."
    };
    const fixture = createFixture({
      resolve: () => resolution({
        agent_mode: "trusted_local_write",
        blockers: [blocker]
      })
    });

    const plan = await fixture.service.plan(request(), context());

    expect(plan.execution).toEqual({
      available: false,
      blockers: [blocker]
    });
    expect(plan.execution).not.toHaveProperty("confirmation_token");
  });

  it("does not burn a confirmation on an exchanged actor binding", async () => {
    const fixture = createFixture();
    const plan = await fixture.service.plan(request(), context());

    await expect(fixture.service.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      context("local-session-actor-b")
    )).rejects.toMatchObject({
      code: "studio_agent_test_confirmation_invalid"
    });
    await expect(fixture.service.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      context()
    )).resolves.toMatchObject({ output: { status: "ok" } });
  });

  it("expires exactly at the confirmation boundary", async () => {
    const fixture = createFixture({ ttlMs: 500 });
    const plan = await fixture.service.plan(request(), context());
    fixture.setNow(BASE_TIME + 500);

    await expect(fixture.service.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      context()
    )).rejects.toMatchObject({
      code: "studio_agent_test_confirmation_invalid"
    });
    expect(fixture.commands).toHaveLength(0);
  });

  it("allows only one concurrent execution for a confirmation", async () => {
    const fixture = createFixture();
    const plan = await fixture.service.plan(request(), context());

    const attempts = await Promise.allSettled([
      fixture.service.execute(
        plan.plan_id,
        executeRequest(TOKEN),
        context()
      ),
      fixture.service.execute(
        plan.plan_id,
        executeRequest(TOKEN),
        context()
      )
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled"))
      .toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected"))
      .toHaveLength(1);
    expect(fixture.commands).toHaveLength(1);
  });

  it("fails closed when the re-resolved snapshot changes", async () => {
    const fixture = createFixture({
      resolve: (generation) => resolution({
        catalog_fingerprint: digest(`catalog-v${generation}`)
      })
    });
    const plan = await fixture.service.plan(request(), context());

    await expect(fixture.service.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      context()
    )).rejects.toMatchObject({ code: "studio_agent_test_plan_stale" });
    expect(fixture.commands).toHaveLength(0);
  });

  it("maps schema-invalid output and consumes the confirmation", async () => {
    const fixture = createFixture({
      run: async () => {
        throw new AgentRuntimeError(
          "runtime_output_schema_invalid",
          "bad output"
        );
      }
    });
    const plan = await fixture.service.plan(request(), context());

    await expect(fixture.service.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      context()
    )).rejects.toMatchObject({ code: "studio_agent_test_output_invalid" });
    await expect(fixture.service.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      context()
    )).rejects.toMatchObject({
      code: "studio_agent_test_confirmation_invalid"
    });
  });

  it("marks provider ambiguity as outcome unknown and never retries it", async () => {
    const fixture = createFixture({
      run: async () => {
        throw new AgentRuntimeError(
          "runtime_provider_unavailable",
          "connection dropped after request"
        );
      }
    });
    const plan = await fixture.service.plan(request(), context());

    await expect(fixture.service.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      context()
    )).rejects.toMatchObject({
      code: "studio_agent_test_outcome_unknown",
      details: { outcome_unknown: true }
    });
    await expect(fixture.service.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      context()
    )).rejects.toMatchObject({
      code: "studio_agent_test_confirmation_invalid"
    });
    expect(fixture.commands).toHaveLength(1);
  });

  it("does not return an output that exceeds the Studio response budget", async () => {
    const fixture = createFixture({
      run: async () => ({
        output: { body: "x".repeat(2 * 1024 * 1024) }
      })
    });
    const plan = await fixture.service.plan(request(), context());

    await expect(fixture.service.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      context()
    )).rejects.toMatchObject({ code: "studio_agent_test_output_invalid" });
  });
});
