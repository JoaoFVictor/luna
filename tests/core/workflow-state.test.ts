import { describe, expect, it } from "vitest";
import {
  resolveWorkflowInput,
  type WorkflowState
} from "../../src/core/workflow-state.js";

describe("workflow state", () => {
  it("resolves invocation and step references in configured node input", () => {
    const state = {
      invocation: { target: "github_pr", pull_number: 123 },
      steps: {
        repo_context: { files: [{ path: "a.ts" }] },
        review_plan: { summary: "Plan" }
      }
    };

    expect(
      resolveWorkflowInput(
        {
          invocation: "$.invocation",
          repo_context: "$.steps.repo_context",
          review_plan: "$.steps.review_plan"
        },
        state
      )
    ).toEqual({
      invocation: { target: "github_pr", pull_number: 123 },
      repo_context: { files: [{ path: "a.ts" }] },
      review_plan: { summary: "Plan" }
    });
  });

  it("resolves repository, run, and workspace references", () => {
    const state = {
      invocation: {},
      repository: { owner: "octo", repo: "hello" },
      run: { id: "run-123" },
      workspace: { path: "/tmp/workspace" },
      steps: {}
    };

    expect(
      resolveWorkflowInput(
        {
          repository: "$.repository",
          run: "$.run",
          workspace: "$.workspace"
        },
        state
      )
    ).toEqual({
      repository: { owner: "octo", repo: "hello" },
      run: { id: "run-123" },
      workspace: { path: "/tmp/workspace" }
    });
  });

  it("resolves flattened config references", () => {
    expect(
      resolveWorkflowInput(
        {
          commands: "$.config.implementation.validation.commands",
          invocation: "$.invocation",
          cwd: "$.workspace.path"
        },
        {
          invocation: { target: "jira_task" },
          workspace: {
            run_id: "run-1",
            path: "/tmp/worktree",
            preserved: true,
            reason: "created"
          },
          steps: {},
          config: {
            implementation: {
              validation: {
                commands: [{ cmd: "npm", args: ["test"], timeout_ms: 120000 }]
              }
            }
          }
        } as WorkflowState
      )
    ).toEqual({
      commands: [{ cmd: "npm", args: ["test"], timeout_ms: 120000 }],
      invocation: { target: "jira_task" },
      cwd: "/tmp/worktree"
    });
  });

  it("preserves literal string values that are not references", () => {
    const state = {
      invocation: {},
      steps: {}
    };

    expect(
      resolveWorkflowInput(
        {
          mode: "literal",
          path: "steps.review_plan"
        },
        state
      )
    ).toEqual({
      mode: "literal",
      path: "steps.review_plan"
    });
  });

  it("throws when an input references an unsupported workflow state path", () => {
    expect(() =>
      resolveWorkflowInput(
        {
          unknown: "$.unknown"
        },
        {
          invocation: {},
          steps: {}
        }
      )
    ).toThrow(expect.objectContaining({ code: "workflow_reference_unsupported" }));
  });

  it.each(["$.repository", "$.run", "$.workspace"])(
    "throws when an input references missing %s state",
    (reference) => {
      expect(() =>
        resolveWorkflowInput(
          {
            value: reference
          },
          {
            invocation: {},
            steps: {}
          }
        )
      ).toThrow(expect.objectContaining({ code: "workflow_reference_missing" }));
    }
  );

  it("throws when an input references an empty step id", () => {
    expect(() =>
      resolveWorkflowInput(
        { empty_step: "$.steps." },
        {
          invocation: {},
          steps: { "": "invalid" }
        }
      )
    ).toThrow(expect.objectContaining({ code: "workflow_reference_unsupported" }));
  });

  it("throws when an input references a missing step output", () => {
    expect(() =>
      resolveWorkflowInput(
        { repo_context: "$.steps.repo_context" },
        {
          invocation: {},
          steps: {}
        }
      )
    ).toThrow(expect.objectContaining({ code: "workflow_reference_missing" }));
  });
});
