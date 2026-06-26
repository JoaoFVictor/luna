import { describe, expect, it } from "vitest";
import { manifest } from "../../../src/capabilities/agents/manifest.js";
import type { RunAgentInput } from "../../../src/core/agent-runtime/contracts.js";
import { matchesJsonSchema } from "../../../src/core/capabilities/json-schema.js";
import type { RunHandle } from "../../../src/core/runtime/run-handle.js";

describe("agents capability manifest", () => {
  it("keeps agents.run_input aligned with the runtime port input contract", () => {
    const schema = manifest.schemas?.["agents.run_input"]?.schema;
    const input: RunAgentInput = {
      run: { run_id: "run-1" } as RunHandle,
      node_id: "review_plan",
      agent_id: "reviewer",
      agent_mode: "read_only",
      instructions: "Review the task.",
      input: { issue: "LUNA-1" },
      output_schema: {
        type: "object",
        additionalProperties: true
      },
      model_profile: {
        model: "gpt-5",
        reasoning_effort: "medium"
      },
      tools: {
        tools: [],
        runtime_requirements: []
      },
      context: { files: [] },
      cwd: "/repo",
      runtime_requirements: [],
      signal: undefined,
      events: undefined
    };

    expect(schema).toBeDefined();
    expect(matchesJsonSchema(schema, input)).toBe(true);
  });
});
