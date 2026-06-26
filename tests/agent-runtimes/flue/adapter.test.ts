import { describe, expect, it, vi } from "vitest";
import {
  createFlueAgentRuntimeAdapter
} from "../../../src/agent-runtimes/flue/adapter.js";
import {
  AgentRuntimeError,
  type RunAgentInput
} from "../../../src/core/agent-runtime/contracts.js";

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    run: {
      run_id: "run-1",
      workflow_id: "workflow-1",
      attempt: 1,
      started_at: "2026-06-26T00:00:00.000Z"
    },
    node_id: "node-1",
    agent_id: "agent-1",
    agent_mode: "read_only",
    instructions: "Run.",
    input: {},
    output_schema: { type: "object", additionalProperties: true },
    model_profile: { model: "openai/gpt-5", reasoning_effort: "low" },
    tools: { tools: [], runtime_requirements: [] },
    context: undefined,
    runtime_requirements: [],
    signal: undefined,
    events: undefined,
    ...overrides
  };
}

describe("Flue agent runtime adapter", () => {
  it("describes Flue capabilities through the runtime-agnostic port", () => {
    const adapter = createFlueAgentRuntimeAdapter({
      runner: vi.fn()
    });

    expect(adapter.describe()).toEqual({
      id: "flue",
      display_name: "Flue",
      supported_tool_protocols: ["local", "mcp"],
      supported_runtime_requirements: ["tool_calling", "mcp_tools"]
    });
  });

  it("validates before invoking the runner", async () => {
    const runner = vi.fn();
    const adapter = createFlueAgentRuntimeAdapter({ runner });

    await expect(
      adapter.runAgent(
        input({
          tools: {
            tools: [
              {
                id: "repository.status",
                protocol: "local",
                input_schema: {},
                output_schema: {},
                runtime_requirements: [],
                source: "local_contract"
              }
            ],
            runtime_requirements: []
          }
        })
      )
    ).rejects.toMatchObject({
      code: "runtime_unsupported_feature",
      details: { missing_requirement: "tool_calling" }
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("delegates to an injected runner and returns normalized output", async () => {
    const runner = vi.fn(async () => ({
      output: { summary: "ok" },
      usage: { input_tokens: 3 },
      runtime_metadata: { session_id: "session-1" }
    }));
    const adapter = createFlueAgentRuntimeAdapter({ runner });

    await expect(adapter.runAgent(input())).resolves.toEqual({
      output: { summary: "ok" },
      usage: { input_tokens: 3 },
      runtime_metadata: { session_id: "session-1" }
    });
    expect(runner).toHaveBeenCalledWith(input());
  });

  it("normalizes runtime-specific runner errors", async () => {
    const runnerError = new Error("auth failed") as Error & { code: string };
    runnerError.code = "flue_auth_failed";
    const adapter = createFlueAgentRuntimeAdapter({
      runner: vi.fn(async () => {
        throw runnerError;
      })
    });

    await expect(adapter.runAgent(input())).rejects.toMatchObject({
      code: "runtime_auth_failed",
      message: "auth failed"
    });

    const normalized = new AgentRuntimeError(
      "runtime_output_schema_invalid",
      "Bad output"
    );
    const alreadyNormalizedAdapter = createFlueAgentRuntimeAdapter({
      runner: vi.fn(async () => {
        throw normalized;
      })
    });

    await expect(alreadyNormalizedAdapter.runAgent(input())).rejects.toBe(
      normalized
    );
  });

  it("keeps unknown Flue runner errors unknown instead of guessing by substring", async () => {
    const runnerError = new Error("auth-ish wording") as Error & { code: string };
    runnerError.code = "flue_unmapped_auth_like_code";
    const adapter = createFlueAgentRuntimeAdapter({
      runner: vi.fn(async () => {
        throw runnerError;
      })
    });

    await expect(adapter.runAgent(input())).rejects.toMatchObject({
      code: "runtime_unknown_failure",
      details: { original_code: "flue_unmapped_auth_like_code" }
    });
  });
});
