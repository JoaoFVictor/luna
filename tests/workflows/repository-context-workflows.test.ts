import { describe, expect, it } from "vitest";
import { loadNativeWorkflowDefinition } from "../../src/platform/native/native-run-context.js";

describe("canonical repository context workflow integration", () => {
  it("uses one repository-context built-in for review and implementation sources", async () => {
    const [codeReview, implementation] = await Promise.all([
      loadNativeWorkflowDefinition({
        projectRoot: process.cwd(),
        workflowId: "code-review"
      }),
      loadNativeWorkflowDefinition({
        projectRoot: process.cwd(),
        workflowId: "implementation"
      })
    ]);

    expect(codeReview.graph.nodes.find((node) => node.id === "related_context"))
      .toMatchObject({
        type: "built_in",
        uses: "repository-context.related_context",
        input: {
          repo_context: { expression: "$.steps.repo_context" },
          config: { expression: "$.config.code_review.related_context" }
        }
      });
    expect(
      implementation.graph.nodes.find((node) => node.id === "repository_context")
    ).toMatchObject({
      type: "built_in",
      uses: "repository-context.related_context",
      input: {
        task: {
          text: {
            expression:
              "$.steps.task_context.implementation_title & '\n\n' & $.steps.task_context.change_request_body"
          }
        },
        config: { expression: "$.config.implementation.repository_context" }
      }
    });
  });

  it("refreshes implementation context from each attempt diff before reviews", async () => {
    const workflow = await loadNativeWorkflowDefinition({
      projectRoot: process.cwd(),
      workflowId: "implementation"
    });
    const pattern = workflow.graph.nodes.find((node) => node.id === "implementation");
    if (pattern?.type !== "pattern") {
      throw new Error("implementation pattern is missing");
    }

    expect(pattern.input).toMatchObject({
      repository_context: { expression: "$.steps.repository_context" }
    });
    expect(pattern.evidence).toEqual([{
      id: "repository_context",
      uses: "repository-context.related_context",
      input: {
        worktree_diff: {
          diff: { expression: "$.gate.diff_summary" },
          task: {
            text: {
              expression:
                "$.steps.task_context.implementation_title & '\n\n' & $.steps.task_context.change_request_body"
            }
          }
        },
        config: { expression: "$.config.implementation.repository_context" }
      }
    }]);

    for (const gateId of ["review", "acceptance"]) {
      expect(pattern.gates?.find((gate) => gate.id === gateId)?.input?.subject)
        .toEqual({
          gate: { expression: "$.gate" },
          task_context: { expression: "$.steps.task_context" },
          implementation_plan: { expression: "$.steps.implementation_plan" }
        });
    }
  });
});
