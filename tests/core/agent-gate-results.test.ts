import { describe, expect, it } from "vitest";
import { gateResultFromAgentOutput } from "../../src/core/agents/gate-results.js";

describe("flue gate results", () => {
  it("blocks when a JSONata gate expression evaluates to true", async () => {
    const result = await gateResultFromAgentOutput({
      id: "review",
      type: "agent",
      blockWhen: { expression: "$count(findings) > 0" },
      feedback: { expression: "findings" },
      output: {
        findings: [{ title: "Missing validation" }]
      }
    });

    expect(result).toEqual({
      id: "review",
      type: "agent",
      passed: false,
      feedback: JSON.stringify([{ title: "Missing validation" }]),
      output: {
        findings: [{ title: "Missing validation" }]
      }
    });
  });

  it("passes when a JSONata gate expression evaluates to false", async () => {
    const result = await gateResultFromAgentOutput({
      id: "acceptance",
      type: "agent",
      blockWhen: { expression: "status != 'accepted'" },
      feedback: {
        expression: "{ 'status': status, 'blocking_reasons': blocking_reasons }"
      },
      output: {
        status: "accepted",
        blocking_reasons: []
      }
    });

    expect(result).toEqual({
      id: "acceptance",
      type: "agent",
      passed: true,
      output: {
        status: "accepted",
        blocking_reasons: []
      }
    });
  });

  it("rejects JSONata block expressions that do not return booleans", async () => {
    await expect(
      gateResultFromAgentOutput({
        id: "review",
        type: "agent",
        blockWhen: { expression: "findings" },
        output: {
          findings: []
        }
      })
    ).rejects.toMatchObject({
      code: "gated_agent_loop_gate_block_when_not_boolean"
    });
  });
});
