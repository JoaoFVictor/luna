import { describe, expect, it } from "vitest";
import {
  selectReadyBatchWithPolicy,
  splitDeferredFinalReportNodesByPolicy
} from "../../src/core/workflow/execution-policy.js";
import type { WorkflowNode } from "../../src/core/workflow/definition.js";

type BuiltInWorkflowNode = Extract<WorkflowNode, { type: "built_in" }>;
type AgentWorkflowNode = Extract<WorkflowNode, { type: "agent" }>;

function builtInNode(id: string, after?: string[]): BuiltInWorkflowNode {
  return {
    id,
    type: "built_in",
    uses: "runtime.preflight",
    ...(after === undefined ? {} : { after })
  };
}

function agentNode(id: string, after?: string[]): AgentWorkflowNode {
  return {
    id,
    type: "agent",
    agent: "reviewer",
    output_schema: "agent-output",
    ...(after === undefined ? {} : { after })
  };
}

describe("workflow execution policy", () => {
  it("does not select duplicate artifact paths in the same batch", () => {
    const plan = selectReadyBatchWithPolicy({
      ready: [
        {
          ...builtInNode("a"),
          artifacts: [
            {
              path: "shared.json",
              source: "$.steps.a",
              format: "json",
              required: true
            }
          ]
        },
        {
          ...builtInNode("b"),
          artifacts: [
            {
              path: "shared.json",
              source: "$.steps.b",
              format: "json",
              required: true
            }
          ]
        },
        {
          ...builtInNode("c"),
          artifacts: [
            {
              path: "other.json",
              source: "$.steps.c",
              format: "json",
              required: true
            }
          ]
        }
      ],
      maxConcurrency: 3,
      builtInMetadata: () => ({})
    });

    expect(plan.items.map((item) => item.node.id)).toEqual(["a", "c"]);
    expect(plan.items.map((item) => item.decision.artifactPaths)).toEqual([
      ["shared.json"],
      ["other.json"]
    ]);
  });

  it("selects only one agent-like node per batch while allowing built-ins", () => {
    const plan = selectReadyBatchWithPolicy({
      ready: [
        agentNode("agent_a"),
        builtInNode("preflight"),
        agentNode("agent_b")
      ],
      maxConcurrency: 3,
      builtInMetadata: () => ({})
    });

    expect(plan.items.map((item) => item.node.id)).toEqual([
      "agent_a",
      "preflight"
    ]);
    expect(plan.items[0]?.decision.batchExclusionKeys).toEqual([
      "agent_session"
    ]);
    expect(plan.items[1]?.decision.batchExclusionKeys).toEqual([]);
  });

  it("allows marked read-only agent sessions to share a batch", () => {
    const plan = selectReadyBatchWithPolicy({
      ready: [
        { ...agentNode("agent_a"), agent_session: { isolation: "shared" } },
        { ...agentNode("agent_b"), agent_session: { isolation: "shared" } },
        agentNode("trusted_writer")
      ],
      maxConcurrency: 3,
      builtInMetadata: () => ({})
    });

    expect(plan.items.map((item) => item.node.id)).toEqual([
      "agent_a",
      "agent_b",
      "trusted_writer"
    ]);
    expect(plan.items[0]?.decision.batchExclusionKeys).toEqual([]);
    expect(plan.items[1]?.decision.batchExclusionKeys).toEqual([]);
    expect(plan.items[2]?.decision.batchExclusionKeys).toEqual([
      "agent_session"
    ]);
  });

  it("serializes workspace capture decisions", () => {
    const plan = selectReadyBatchWithPolicy({
      ready: [
        {
          id: "workspace_a",
          type: "built_in",
          uses: "repository-workspace.capture"
        },
        {
          id: "workspace_b",
          type: "built_in",
          uses: "repository-workspace.capture"
        },
        builtInNode("free")
      ],
      maxConcurrency: 3,
      builtInMetadata: (node) =>
        node.id.startsWith("workspace") ? { capturesWorkspace: true } : {}
    });

    expect(plan.items.map((item) => item.node.id)).toEqual([
      "workspace_a",
      "free"
    ]);
    expect(plan.items[0]?.decision).toMatchObject({
      capturesWorkspace: true,
      batchExclusionKeys: ["workspace_capture"]
    });
    expect(plan.items[1]?.decision).toMatchObject({
      capturesWorkspace: false,
      batchExclusionKeys: []
    });
  });

  it("rejects nodes that depend on deferred final reports", () => {
    expect(() =>
      splitDeferredFinalReportNodesByPolicy({
        nodes: [
          { id: "final", type: "built_in", uses: "reports.final_report" },
          {
            id: "after_final",
            type: "built_in",
            uses: "runtime.preflight",
            after: ["final"]
          }
        ],
        builtInMetadata: (node) =>
          node.id === "final"
            ? { deferredLifecycle: "final_report" }
            : {}
      })
    ).toThrow(expect.objectContaining({
      code: "workflow_deferred_dependency_invalid"
    }));
  });

});
