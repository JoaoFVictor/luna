import { describe, expect, it } from "vitest";
import {
  AgentRuntimeError,
  AgentRuntimePortSchema,
  AgentRuntimeRequirementSchema,
  RuntimeErrorCodeSchema,
  normalizeAgentRuntimeError,
  type AgentRuntimePort,
  type RunAgentInput,
  type RunAgentOutput
} from "../../../src/core/agent-runtime/contracts.js";

const run = {
  run_id: "run-1",
  workflow_id: "workflow-1",
  attempt: 1,
  started_at: "2026-06-26T00:00:00.000Z"
};

const baseInput = {
  run,
  node_id: "review",
  agent_id: "change-reviewer",
  agent_mode: "read_only",
  instructions: "Review the change.",
  input: { files: ["src/example.ts"] },
  output_schema: {
    type: "object",
    additionalProperties: true
  },
  model_profile: {
    model: "openai/gpt-5",
    reasoning_effort: "medium"
  },
  tools: { tools: [], runtime_requirements: [] },
  context: { repository: "context" },
  runtime_requirements: [],
  signal: undefined,
  events: undefined
} satisfies RunAgentInput;

describe("agent runtime contracts", () => {
  it("defines the runtime port and runAgent input/output shape", async () => {
    const output: RunAgentOutput = {
      output: { ok: true },
      usage: { input_tokens: 10, output_tokens: 2 },
      runtime_metadata: { runtime: "test" }
    };
    const port: AgentRuntimePort = {
      describe: () => ({
        id: "test-runtime",
        display_name: "Test Runtime",
        supported_tool_protocols: ["local"],
        supported_runtime_requirements: ["tool_calling"]
      }),
      validate: async (input) => {
        expect(input).toMatchObject({
          node_id: "review",
          agent_id: "change-reviewer"
        });
      },
      runAgent: async (input) => {
        expect(input.run.run_id).toBe("run-1");
        return output;
      }
    };

    expect(AgentRuntimePortSchema.parse(port)).toBe(port);
    await expect(port.validate(baseInput)).resolves.toBeUndefined();
    await expect(port.runAgent(baseInput)).resolves.toEqual(output);
  });

  it("keeps runtime requirements and normalized error codes explicit", () => {
    expect(AgentRuntimeRequirementSchema.options).toEqual([
      "tool_calling",
      "mcp_tools"
    ]);
    expect(RuntimeErrorCodeSchema.options).toEqual([
      "runtime_unsupported_feature",
      "runtime_auth_failed",
      "runtime_rate_limited",
      "runtime_provider_unavailable",
      "runtime_tool_materialization_failed",
      "runtime_output_schema_invalid",
      "runtime_cancelled",
      "runtime_unknown_failure"
    ]);
  });

  it("keeps core runtime error normalization explicit and runtime-agnostic", () => {
    const alreadyNormalized = new AgentRuntimeError(
      "runtime_cancelled",
      "Cancelled"
    );

    expect(normalizeAgentRuntimeError(alreadyNormalized)).toBe(alreadyNormalized);
    const runtimeSpecific = new Error("rate limit") as Error & { code: string };
    runtimeSpecific.code = "flue_rate_limited";
    expect(normalizeAgentRuntimeError(runtimeSpecific)).toMatchObject({
      code: "runtime_unknown_failure",
      message: "rate limit",
      details: { original_code: "flue_rate_limited" }
    });
    expect(normalizeAgentRuntimeError("boom")).toMatchObject({
      code: "runtime_unknown_failure",
      message: "Unknown runtime failure"
    });
  });
});
