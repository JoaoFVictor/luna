import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition.js";
import { findStudioWorkflowAgentContextIssue } from "../../../src/studio/adapters/native/workflow-agent-context.js";

function workflow(nodes: WorkflowDefinition["graph"]["nodes"]): WorkflowDefinition {
  return {
    id: "context-flow",
    type: "workflow",
    mode: "read_only",
    directory: "/not-read",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: {},
    output_schema_content: {},
    capabilities: ["context", "agents", "quality-gates"],
    graph: { nodes },
    revision: "sha256:test",
    external_definition_digests: {},
    execution: { max_concurrency: 1 },
    requires: { repository: false },
    observability: {
      exporters: { runtime_log: { enabled: true, required: false } }
    },
    subagent_policy: { allow_write: false }
  };
}

const loadAgent = async (agentId: string) => ({
  context: agentId === "contextual" ? { files: ["context.md"] } : undefined
});

describe("Studio workflow agent context validation", () => {
  it("diagnoses a context-dependent agent without explicit collection and passage", async () => {
    const issue = await findStudioWorkflowAgentContextIssue(
      workflow([
        {
          id: "execute",
          type: "agent",
          agent: "contextual",
          output_schema: "output.schema.json"
        }
      ]),
      loadAgent
    );

    expect(issue).toEqual({
      agentId: "contextual",
      nodeId: "execute",
      nodeIndex: 0,
      fieldPath: "$.nodes[0].input.context"
    });
  });

  it("accepts transitive execution dependency plus explicit context expression", async () => {
    const issue = await findStudioWorkflowAgentContextIssue(
      workflow([
        {
          id: "context",
          type: "built_in",
          uses: "context.collect_context",
          input: { agents: ["contextual"] }
        },
        {
          id: "prepare",
          type: "built_in",
          uses: "runtime.preflight",
          after: ["context"]
        },
        {
          id: "execute",
          type: "pattern",
          uses: "quality-gates.gated_agent_loop",
          worker: "contextual",
          input: { context: { expression: "$.steps.context" } },
          after: ["prepare"]
        }
      ]),
      loadAgent
    );

    expect(issue).toBeUndefined();
  });

  it("diagnoses a contextual agent-review gate independently from its worker", async () => {
    const issue = await findStudioWorkflowAgentContextIssue(
      workflow([
        {
          id: "context",
          type: "built_in",
          uses: "context.collect_context",
          input: { agents: ["contextual"] }
        },
        {
          id: "execute",
          type: "pattern",
          uses: "quality-gates.gated_agent_loop",
          worker: "plain",
          input: { context: { expression: "$.steps.context" } },
          gates: [{
            id: "review",
            type: "quality-gates.agent_review",
            input: {
              review_agent: "contextual",
              subject: { expression: "$.gate" }
            }
          }],
          after: ["context"]
        }
      ]),
      loadAgent
    );

    expect(issue).toEqual({
      agentId: "contextual",
      nodeId: "execute",
      nodeIndex: 1,
      fieldPath: "$.nodes[1].gates[0].input.context"
    });
  });

  it("accepts a contextual agent-review gate with collection, dependency, and gate context", async () => {
    const issue = await findStudioWorkflowAgentContextIssue(
      workflow([
        {
          id: "context",
          type: "built_in",
          uses: "context.collect_context",
          input: { agents: ["contextual"] }
        },
        {
          id: "prepare",
          type: "built_in",
          uses: "runtime.preflight",
          after: ["context"]
        },
        {
          id: "execute",
          type: "pattern",
          uses: "quality-gates.gated_agent_loop",
          worker: "plain",
          gates: [{
            id: "review",
            type: "quality-gates.agent_review",
            input: {
              review_agent: "contextual",
              context: { expression: "$.steps.context" },
              subject: { expression: "$.gate" }
            }
          }],
          after: ["prepare"]
        }
      ]),
      loadAgent
    );

    expect(issue).toBeUndefined();
  });

  it.each([
    {
      missing: "collector registration",
      collectorAgents: ["plain"],
      after: ["context"]
    },
    {
      missing: "execution dependency",
      collectorAgents: ["contextual"],
      after: []
    }
  ])("diagnoses a contextual reviewer missing $missing", async ({
    collectorAgents,
    after
  }) => {
    const issue = await findStudioWorkflowAgentContextIssue(
      workflow([
        {
          id: "context",
          type: "built_in",
          uses: "context.collect_context",
          input: { agents: collectorAgents }
        },
        {
          id: "execute",
          type: "pattern",
          uses: "quality-gates.gated_agent_loop",
          worker: "plain",
          gates: [{
            id: "review",
            type: "quality-gates.agent_review",
            input: {
              review_agent: "contextual",
              context: { expression: "$.steps.context" },
              subject: { expression: "$.gate" }
            }
          }],
          after
        }
      ]),
      loadAgent
    );

    expect(issue?.fieldPath).toBe("$.nodes[1].gates[0].input.context");
  });

  it("does not impose context collection on agents without context files", async () => {
    const issue = await findStudioWorkflowAgentContextIssue(
      workflow([
        {
          id: "execute",
          type: "agent",
          agent: "plain",
          output_schema: "output.schema.json"
        }
      ]),
      loadAgent
    );

    expect(issue).toBeUndefined();
  });

  it("does not confuse a collector id with a longer dotted step path", async () => {
    const issue = await findStudioWorkflowAgentContextIssue(
      workflow([
        {
          id: "context",
          type: "built_in",
          uses: "context.collect_context",
          input: { agents: ["contextual"] }
        },
        {
          id: "execute",
          type: "agent",
          agent: "contextual",
          output_schema: "output.schema.json",
          input: { context: { expression: "$.steps.context.payload" } },
          after: ["context"]
        }
      ]),
      loadAgent
    );

    expect(issue?.nodeId).toBe("execute");
  });
});
