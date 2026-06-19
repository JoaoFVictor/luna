import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflowDefinition } from "../../src/core/workflow-definition.js";

async function tempWorkflowRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "luna-workflow-definition-"));
}

describe("workflow definition loader", () => {
  it("loads workflow.yaml and graph.yaml for a configured workflow", async () => {
    const root = await tempWorkflowRoot();
    const workflowDir = path.join(root, "code-review");

    try {
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        path.join(workflowDir, "workflow.yaml"),
        [
          "id: code-review",
          "type: workflow",
          "mode: git_managed_read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "graph: graph.yaml",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(workflowDir, "graph.yaml"),
        [
          "nodes:",
          "  - id: repo_context",
          "    type: built_in",
          "    uses: collect_repo_context",
          "  - id: review_plan",
          "    type: agent",
          "    agent: review-planner",
          "    output_schema: review_plan",
          "    after:",
          "      - repo_context",
          ""
        ].join("\n"),
        "utf8"
      );

      await expect(loadWorkflowDefinition(root, "code-review")).resolves.toMatchObject({
        id: "code-review",
        mode: "git_managed_read_only",
        graph: {
          nodes: [
            { id: "repo_context", type: "built_in", uses: "collect_repo_context" },
            { id: "review_plan", type: "agent", agent: "review-planner" }
          ]
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads git-managed write workflows with agent_loop nodes", async () => {
    const root = await tempWorkflowRoot();
    const workflowDir = path.join(root, "implementation");

    try {
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        path.join(workflowDir, "workflow.yaml"),
        [
          "id: implementation",
          "type: workflow",
          "mode: git_managed_write",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "graph: graph.yaml",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(workflowDir, "graph.yaml"),
        [
          "nodes:",
          "  - id: implementation",
          "    type: agent_loop",
          "    agent: code-implementer",
          "    output_schema: implementation_result",
          "    artifact:",
          "      attempts: implementation-attempts.json",
          "      validation: validation.json",
          "      result: implementation-result.json",
          "      diff: implementation-diff.json",
          "    sandbox:",
          "      type: trusted_host_local",
          "      cwd: $.workspace.path",
          "      env_allowlist: []",
          "    validation:",
          "      commands: $.config.implementation.validation.commands",
          "      max_output_bytes: $.config.implementation.validation.max_output_bytes",
          "    repair:",
          "      attempts: $.config.implementation.validation.repair_attempts",
          ""
        ].join("\n"),
        "utf8"
      );

      await expect(loadWorkflowDefinition(root, "implementation")).resolves.toMatchObject({
        id: "implementation",
        mode: "git_managed_write",
        graph: {
          nodes: [
            {
              id: "implementation",
              type: "agent_loop",
              artifact: {
                validation: "validation.json",
                diff: "implementation-diff.json"
              }
            }
          ]
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads agent_loop artifact maps without requiring specific output keys", async () => {
    const root = await tempWorkflowRoot();
    const workflowDir = path.join(root, "implementation");

    try {
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        path.join(workflowDir, "workflow.yaml"),
        [
          "id: implementation",
          "type: workflow",
          "mode: git_managed_write",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "graph: graph.yaml",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(workflowDir, "graph.yaml"),
        [
          "nodes:",
          "  - id: implementation",
          "    type: agent_loop",
          "    agent: code-implementer",
          "    output_schema: implementation_result",
          "    artifact:",
          "      summary: summary.json",
          "      report: report.md",
          "    sandbox:",
          "      type: trusted_host_local",
          "      cwd: $.workspace.path",
          "      env_allowlist: []",
          "    validation:",
          "      commands: $.config.implementation.validation.commands",
          "      max_output_bytes: $.config.implementation.validation.max_output_bytes",
          "    repair:",
          "      attempts: $.config.implementation.validation.repair_attempts",
          ""
        ].join("\n"),
        "utf8"
      );

      await expect(loadWorkflowDefinition(root, "implementation")).resolves.toMatchObject({
        graph: {
          nodes: [
            {
              id: "implementation",
              type: "agent_loop",
              artifact: {
                summary: "summary.json",
                report: "report.md"
              }
            }
          ]
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate node ids", async () => {
    const root = await tempWorkflowRoot();
    const workflowDir = path.join(root, "code-review");

    try {
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        path.join(workflowDir, "workflow.yaml"),
        [
          "id: code-review",
          "type: workflow",
          "mode: git_managed_read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "graph: graph.yaml",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(workflowDir, "graph.yaml"),
        [
          "nodes:",
          "  - id: same",
          "    type: built_in",
          "    uses: preflight",
          "  - id: same",
          "    type: built_in",
          "    uses: collect_repo_context",
          ""
        ].join("\n"),
        "utf8"
      );

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code: "workflow_node_duplicate"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects dependencies that do not exist", async () => {
    const root = await tempWorkflowRoot();
    const workflowDir = path.join(root, "code-review");

    try {
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        path.join(workflowDir, "workflow.yaml"),
        [
          "id: code-review",
          "type: workflow",
          "mode: git_managed_read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "graph: graph.yaml",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(workflowDir, "graph.yaml"),
        [
          "nodes:",
          "  - id: review_plan",
          "    type: agent",
          "    agent: review-planner",
          "    output_schema: review_plan",
          "    after:",
          "      - missing",
          ""
        ].join("\n"),
        "utf8"
      );

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code: "workflow_dependency_unknown"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects cyclic dependencies", async () => {
    const root = await tempWorkflowRoot();
    const workflowDir = path.join(root, "code-review");

    try {
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        path.join(workflowDir, "workflow.yaml"),
        [
          "id: code-review",
          "type: workflow",
          "mode: git_managed_read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "graph: graph.yaml",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(workflowDir, "graph.yaml"),
        [
          "nodes:",
          "  - id: first",
          "    type: built_in",
          "    uses: preflight",
          "    after:",
          "      - second",
          "  - id: second",
          "    type: built_in",
          "    uses: collect_repo_context",
          "    after:",
          "      - first",
          ""
        ].join("\n"),
        "utf8"
      );

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code: "workflow_cycle_detected"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads the committed code-review workflow graph", async () => {
    await expect(loadWorkflowDefinition("workflows", "code-review")).resolves.toMatchObject({
      id: "code-review",
      graph: {
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: "repo_context",
            type: "built_in",
            uses: "collect_repo_context"
          }),
          expect.objectContaining({
            id: "review_plan",
            type: "agent",
            agent: "review-planner",
            output_schema: "review_plan"
          }),
          expect.objectContaining({
            id: "final_report",
            type: "built_in",
            uses: "final_code_review_report"
          })
        ])
      }
    });
  });

  it("rejects workflow ids that escape the workflows root", async () => {
    await expect(loadWorkflowDefinition("workflows", "../code-review")).rejects.toMatchObject({
      code: "path_security_violation"
    });
  });

  it("rejects graph paths that escape the workflow directory", async () => {
    const root = await tempWorkflowRoot();
    const workflowDir = path.join(root, "code-review");

    try {
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        path.join(workflowDir, "workflow.yaml"),
        [
          "id: code-review",
          "type: workflow",
          "mode: git_managed_read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "graph: ../graph.yaml",
          ""
        ].join("\n"),
        "utf8"
      );

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code: "workflow_path_escape"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects graph symlinks that resolve outside the workflow directory", async () => {
    const root = await tempWorkflowRoot();
    const workflowDir = path.join(root, "code-review");
    const outsideGraph = path.join(root, "outside-graph.yaml");

    try {
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        path.join(workflowDir, "workflow.yaml"),
        [
          "id: code-review",
          "type: workflow",
          "mode: git_managed_read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "graph: graph.yaml",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        outsideGraph,
        [
          "nodes:",
          "  - id: preflight",
          "    type: built_in",
          "    uses: preflight",
          ""
        ].join("\n"),
        "utf8"
      );
      await symlink(outsideGraph, path.join(workflowDir, "graph.yaml"));

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code: "workflow_path_escape"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
