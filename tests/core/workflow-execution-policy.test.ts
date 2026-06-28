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
  it("selects independent ready built-ins when concurrency allows it", () => {
    const plan = selectReadyBatchWithPolicy({
      ready: [builtInNode("a"), builtInNode("b")],
      maxConcurrency: 2,
      builtInMetadata: () => ({})
    });

    expect(plan.items.map((item) => item.node.id)).toEqual(["a", "b"]);
    expect(plan.items.map((item) => item.decision)).toEqual([
      {
        locks: [],
        batchExclusionKeys: [],
        capturesWorkspace: false,
        deferUntilAfterWorkspaceLifecycle: false,
        artifactPaths: []
      },
      {
        locks: [],
        batchExclusionKeys: [],
        capturesWorkspace: false,
        deferUntilAfterWorkspaceLifecycle: false,
        artifactPaths: []
      }
    ]);
  });

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

  it("carries repository lock decisions without reducing global concurrency", () => {
    const plan = selectReadyBatchWithPolicy({
      ready: [builtInNode("locked"), builtInNode("free")],
      maxConcurrency: 2,
      builtInMetadata: (node) =>
        node.id === "locked"
          ? { locks: [{ resource: "repository", mode: "exclusive" }] }
          : {}
    });

    expect(plan.items.map((item) => item.node.id)).toEqual(["locked", "free"]);
    expect(plan.items[0]?.decision).toMatchObject({
      locks: [{ resource: "repository", mode: "exclusive" }],
      batchExclusionKeys: []
    });
    expect(plan.items[1]?.decision.batchExclusionKeys).toEqual([]);
  });

  it("can select non-exclusive nodes around repository lock decisions", () => {
    const plan = selectReadyBatchWithPolicy({
      ready: [builtInNode("free"), builtInNode("locked"), builtInNode("other")],
      maxConcurrency: 3,
      builtInMetadata: (node) =>
        node.id === "locked"
          ? { locks: [{ resource: "repository", mode: "exclusive" }] }
          : {}
    });

    expect(plan.items.map((item) => item.node.id)).toEqual([
      "free",
      "locked",
      "other"
    ]);
  });

  it("serializes workspace capture decisions", () => {
    const plan = selectReadyBatchWithPolicy({
      ready: [
        {
          id: "workspace_a",
          type: "built_in",
          uses: "pull-request-workspace.prepare_worktree"
        },
        {
          id: "workspace_b",
          type: "built_in",
          uses: "pull-request-workspace.prepare_worktree"
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

  it("carries deferred final report decisions and rejects invalid dependents", () => {
    const nodes = [
      { id: "main", type: "built_in", uses: "runtime.preflight" },
      { id: "final", type: "built_in", uses: "reports.final_report" }
    ] satisfies WorkflowNode[];

    const split = splitDeferredFinalReportNodesByPolicy({
      nodes,
      builtInMetadata: (node) =>
        node.id === "final"
          ? { deferredLifecycle: "final_report" }
          : {}
    });

    expect(split.mainNodes.map((node) => node.id)).toEqual(["main"]);
    expect(split.deferredNodes.map((node) => node.id)).toEqual(["final"]);

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

  it("ignores nodes without deferred lifecycle metadata", () => {
    const split = splitDeferredFinalReportNodesByPolicy({
      nodes: [builtInNode("preflight")],
      builtInMetadata: () => ({})
    });

    expect(split.mainNodes.map((node) => node.id)).toEqual(["preflight"]);
    expect(split.deferredNodes).toEqual([]);
  });
});
