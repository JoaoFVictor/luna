import { describe, expect, it, vi } from "vitest";
import type {
  AgentRuntimePort,
  RunAgentInput
} from "../../../src/core/agent-runtime/contracts.js";
import { runObservedAgent } from "../../../src/core/agent-runtime/observed-runner.js";
import { createObservabilitySummary } from "../../../src/core/observability/summary.js";

const run = {
  run_id: "run-observed-agent",
  workflow_id: "workflow-observed-agent",
  attempt: 1,
  started_at: "2026-06-27T00:00:00.000Z"
};

const input = {
  run,
  node_id: "review",
  agent_id: "change-reviewer",
  agent_mode: "read_only",
  instructions: "Review the change.",
  input: { files: ["src/example.ts"] },
  output_schema: { type: "object", additionalProperties: true },
  model_profile: {
    model: "openai/gpt-5",
    reasoning_effort: "medium"
  },
  tools: { tools: [], runtime_requirements: [] },
  context: {},
  runtime_requirements: [],
  signal: undefined,
  events: undefined
} satisfies RunAgentInput;

function runtime(): AgentRuntimePort {
  return {
    describe: () => ({
      id: "test-agent-runtime",
      display_name: "Test Agent Runtime",
      supported_tool_protocols: ["local"],
      supported_runtime_requirements: ["tool_calling"]
    }),
    validate: vi.fn(),
    runAgent: vi.fn(async () => ({
      output: { ok: true },
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        cost: { total: 0.37 }
      },
      runtime_metadata: {
        provider: "test-provider",
        model: "test-model"
      }
    }))
  };
}

describe("observed agent runner", () => {
  it("does not classify succeeded-event append failures as runtime failures", async () => {
    const summary = createObservabilitySummary({
      runId: "run-observed-agent",
      workflowId: "workflow-observed-agent"
    });
    const eventFailure = new Error("event append failed");
    const emitEvent = vi.fn(async (event: { readonly type: string }) => {
      if (event.type === "agent_call.succeeded") {
        throw eventFailure;
      }
    });

    await expect(
      runObservedAgent({
        runtime: runtime(),
        input,
        observabilitySummary: summary,
        emitEvent,
        now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125)
      })
    ).rejects.toBe(eventFailure);

    expect(summary.prompt_operations).toBe(1);
    expect(summary.usage_missing_count).toBe(0);
    expect(summary.tokens.total).toBe(18);
    expect(emitEvent).toHaveBeenCalledTimes(2);
    expect(emitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_call.failed" })
    );
  });

  it("emits skill and MCP policy audit metadata on agent start", async () => {
    const emitEvent = vi.fn();

    await runObservedAgent({
      runtime: runtime(),
      input: {
        ...input,
        instructions_audit: {
          skills: [
            {
              name: "lint-fix",
              requested_path: ".codex/skills/lint-fix/SKILL.md"
            }
          ]
        },
        tools: {
          tools: [],
          runtime_requirements: ["tool_calling", "mcp_tools"],
          mcp_policy: {
            servers: [
              {
                id: "playwright",
                transport: "stdio",
                command: "npx",
                args: ["-y", "@playwright/mcp@latest"],
                env_vars: [],
                allowed_tools: ["browser_navigate"],
                timeout_ms: 60_000
              }
            ],
            tools: [
              {
                id: "playwright.browser_navigate",
                protocol: "mcp",
                server_id: "playwright",
                tool_name: "browser_navigate"
              }
            ],
            runtime_requirements: ["tool_calling", "mcp_tools"]
          }
        },
        runtime_requirements: ["tool_calling", "mcp_tools"]
      },
      emitEvent
    });

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent_call.started",
        data: expect.objectContaining({
          skills: [
            {
              name: "lint-fix",
              requested_path: ".codex/skills/lint-fix/SKILL.md"
            }
          ],
          tools: {
            local_tool_ids: [],
            mcp_server_ids: ["playwright"],
            mcp_tool_ids: ["playwright.browser_navigate"],
            runtime_requirements: ["tool_calling", "mcp_tools"]
          }
        })
      })
    );
  });
});
