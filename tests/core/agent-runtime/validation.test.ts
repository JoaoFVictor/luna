import { describe, expect, it } from "vitest";
import {
  validateAgentRuntimeInput
} from "../../../src/core/agent-runtime/validation.js";
import type {
  AgentRuntimeDescriptor,
  RunAgentInput
} from "../../../src/core/agent-runtime/contracts.js";

const descriptor: AgentRuntimeDescriptor = {
  id: "test-runtime",
  display_name: "Test Runtime",
  supported_tool_protocols: ["local"],
  supported_runtime_requirements: ["tool_calling"]
};

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

describe("agent runtime validation", () => {
  it("rejects unsupported tool protocols before execution", async () => {
    await expect(
      validateAgentRuntimeInput(
        input({
          tools: {
            tools: [
              {
                id: "third-party.tool",
                protocol: "runtime" as never,
                input_schema: {},
                output_schema: {},
                runtime_requirements: [],
                source: "local_contract"
              }
            ],
            runtime_requirements: []
          }
        }),
        descriptor
      )
    ).rejects.toMatchObject({
      code: "runtime_unsupported_feature",
      details: { tool_id: "third-party.tool", protocol: "runtime" }
    });
  });

  it("requires tool_calling when any tool is present", async () => {
    await expect(
      validateAgentRuntimeInput(
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
        }),
        descriptor
      )
    ).rejects.toMatchObject({
      code: "runtime_unsupported_feature",
      details: { missing_requirement: "tool_calling" }
    });
  });

  it("requires mcp_tools when an MCP tool is present", async () => {
    await expect(
      validateAgentRuntimeInput(
        input({
          runtime_requirements: ["tool_calling"],
          tools: {
            tools: [
              {
                id: "github.get_pull_request",
                protocol: "mcp",
                input_schema: {},
                output_schema: {},
                runtime_requirements: ["tool_calling"],
                source: "mcp_policy"
              }
            ],
            runtime_requirements: ["tool_calling"]
          }
        }),
        {
          ...descriptor,
          supported_tool_protocols: ["local", "mcp"],
          supported_runtime_requirements: ["tool_calling", "mcp_tools"]
        }
      )
    ).rejects.toMatchObject({
      code: "runtime_unsupported_feature",
      details: { missing_requirement: "mcp_tools" }
    });
  });

  it("accepts declared requirements supported by the runtime", async () => {
    await expect(
      validateAgentRuntimeInput(
        input({
          runtime_requirements: ["tool_calling", "mcp_tools"],
          tools: {
            tools: [
              {
                id: "github.get_pull_request",
                protocol: "mcp",
                input_schema: {},
                output_schema: {},
                runtime_requirements: ["tool_calling", "mcp_tools"],
                source: "mcp_policy"
              }
            ],
            runtime_requirements: ["tool_calling", "mcp_tools"]
          }
        }),
        {
          ...descriptor,
          supported_tool_protocols: ["local", "mcp"],
          supported_runtime_requirements: ["tool_calling", "mcp_tools"]
        }
      )
    ).resolves.toBeUndefined();
  });
});
