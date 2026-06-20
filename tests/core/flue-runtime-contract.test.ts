import {
  defineAgentProfile,
  type AgentProfile,
  type PromptResultResponse,
  type PromptUsage,
  type Skill,
  type ToolDefinition
} from "@flue/runtime";
import { describe, expect, expectTypeOf, it } from "vitest";

const usage: PromptUsage = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 18,
  cost: {
    input: 0.01,
    output: 0.02,
    cacheRead: 0.001,
    cacheWrite: 0.002,
    total: 0.033
  }
};

describe("Flue runtime contract", () => {
  it("AgentProfile accepts skills and tools", () => {
    const skill: Skill = {
      name: "luna-test-skill",
      description: "Exercises the Flue AgentProfile capability contract."
    };
    const tool: ToolDefinition = {
      name: "luna_test_tool",
      description: "Returns a deterministic test value.",
      parameters: { type: "object", additionalProperties: false },
      execute: async () => "ok"
    };

    const profile: AgentProfile = {
      name: "contract-agent",
      description: "Contract test profile",
      model: false,
      skills: [skill],
      tools: [tool]
    };

    const defined = defineAgentProfile(profile);

    expect(defined.skills).toEqual([skill]);
    expect(defined.tools).toEqual([tool]);
  });

  it("PromptResultResponse exposes usage and model metadata", () => {
    type Result = { status: "ok" };
    const response: PromptResultResponse<Result> = {
      data: { status: "ok" },
      usage,
      model: {
        provider: "test-provider",
        id: "test-model"
      }
    };

    expect(response.usage.totalTokens).toBe(18);
    expect(response.model).toEqual({
      provider: "test-provider",
      id: "test-model"
    });
    expectTypeOf(response.usage).toMatchTypeOf<PromptUsage>();
  });
});
