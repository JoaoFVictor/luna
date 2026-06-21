import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflowDefinition } from "../../src/core/workflow/definition.js";

async function tempWorkflowRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "luna-workflow-definition-"));
}

async function writeMinimalWorkflow(
  root: string,
  workflowId = "code-review",
  extraMetadata: string[] = []
): Promise<void> {
  const workflowDir = path.join(root, workflowId);
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    path.join(workflowDir, "workflow.yaml"),
    [
      `id: ${workflowId}`,
      "type: workflow",
      "mode: git_managed_read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ...extraMetadata,
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workflowDir, "graph.yaml"),
    [
      "nodes:",
      "  - id: preflight",
      "    type: built_in",
      "    uses: preflight",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeWorkflowGraph(
  root: string,
  graphLines: string[],
  workflowId = "code-review"
): Promise<void> {
  const workflowDir = path.join(root, workflowId);
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    path.join(workflowDir, "workflow.yaml"),
    [
      `id: ${workflowId}`,
      "type: workflow",
      "mode: git_managed_read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(workflowDir, "graph.yaml"), graphLines.join("\n"), "utf8");
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
          "    artifacts:",
          "      - path: implementation-attempts.json",
          "        source: $.steps.implementation.attempts",
          "        format: json",
          "      - path: validation.json",
          "        source: $.steps.implementation.validation",
          "        format: json",
          "      - path: implementation-result.json",
          "        source: $.steps.implementation.result",
          "        format: json",
          "      - path: implementation-diff.json",
          "        source: $.steps.implementation.diff",
          "        format: json",
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
              artifacts: expect.arrayContaining([
                expect.objectContaining({
                  path: "validation.json",
                  source: "$.steps.implementation.validation",
                  format: "json",
                  required: true
                }),
                expect.objectContaining({
                  path: "implementation-diff.json",
                  source: "$.steps.implementation.diff",
                  format: "json",
                  required: true
                })
              ])
            }
          ]
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads agent_loop nodes with literal structured validation commands", async () => {
    const root = await tempWorkflowRoot();

    try {
      await writeWorkflowGraph(root, [
        "nodes:",
        "  - id: implementation",
        "    type: agent_loop",
        "    agent: code-implementer",
        "    output_schema: implementation_result",
        "    sandbox:",
        "      type: trusted_host_local",
        "      cwd: $.workspace.path",
        "      env_allowlist: []",
        "    validation:",
        "      commands:",
        "        - cmd: npm",
        "          args:",
        "            - test",
        "          timeout_ms: 120000",
        "      max_output_bytes: 200000",
        "    repair:",
        "      attempts: 1",
        ""
      ]);

      await expect(loadWorkflowDefinition(root, "code-review")).resolves.toMatchObject({
        graph: {
          nodes: [
            {
              id: "implementation",
              type: "agent_loop",
              validation: {
                commands: [
                  { cmd: "npm", args: ["test"], timeout_ms: 120000 }
                ],
                max_output_bytes: 200000
              }
            }
          ]
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads agent_loop artifact plans without requiring specific output keys", async () => {
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
          "    artifacts:",
          "      - path: summary.json",
          "        source: $.steps.implementation.summary",
          "        format: json",
          "      - path: report.md",
          "        source: $.steps.implementation.report",
          "        format: markdown",
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
              artifacts: expect.arrayContaining([
                expect.objectContaining({
                  path: "summary.json",
                  source: "$.steps.implementation.summary",
                  format: "json",
                  required: true
                }),
                expect.objectContaining({
                  path: "report.md",
                  source: "$.steps.implementation.report",
                  format: "markdown",
                  required: true
                })
              ])
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

  it("rejects built-in node names that are not registered in the built-in catalog", async () => {
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
          "  - id: unknown",
          "    type: built_in",
          "    uses: not_registered",
          ""
        ].join("\n"),
        "utf8"
      );

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toThrow(
        "Unsupported built-in step: not_registered"
      );
      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code: "workflow_built_in_unknown"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects artifacts.root_namespace because workflow id is the only artifact namespace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-workflow-"));
    try {
      await mkdir(path.join(root, "legacy"), { recursive: true });
      await writeFile(
        path.join(root, "legacy", "workflow.yaml"),
        [
          "id: legacy",
          "type: workflow",
          "mode: git_managed_read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "graph: graph.yaml",
          "artifacts:",
          "  root_namespace: old",
          ""
        ].join("\n")
      );
      await writeFile(
        path.join(root, "legacy", "graph.yaml"),
        [
          "nodes:",
          "  - id: preflight",
          "    type: built_in",
          "    uses: preflight",
          ""
        ].join("\n")
      );

      await expect(loadWorkflowDefinition(root, "legacy")).rejects.toMatchObject({
        code: "config_schema_invalid"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses committed workflow execution metadata", async () => {
    const definition = await loadWorkflowDefinition("workflows", "code-review");
    expect(definition.execution).toEqual({
      max_concurrency: 2,
      lock_timeout_ms: 120000
    });
  });

  it("defaults observability to mandatory jsonl and optional runtime_log", async () => {
    const root = await tempWorkflowRoot();
    try {
      await writeMinimalWorkflow(root);

      const definition = await loadWorkflowDefinition(root, "code-review");

      expect(definition.observability).toEqual({
        exporters: {
          runtime_log: { enabled: true, required: false }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defaults subagent policy to disallow write access", async () => {
    const root = await tempWorkflowRoot();
    try {
      await writeMinimalWorkflow(root);

      const definition = await loadWorkflowDefinition(root, "code-review");

      expect(definition.subagent_policy).toEqual({ allow_write: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown subagent policy fields", async () => {
    const root = await tempWorkflowRoot();
    try {
      await writeMinimalWorkflow(root, "code-review", [
        "subagent_policy:",
        "  allow_write: false",
        "  unsupported_key: true"
      ]);

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code: "config_schema_invalid"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects attempts to configure the mandatory jsonl exporter", async () => {
    const root = await tempWorkflowRoot();
    try {
      await writeMinimalWorkflow(root, "code-review", [
        "observability:",
        "  exporters:",
        "    jsonl:",
        "      enabled: false",
        "      required: false"
      ]);

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toThrow(
        "events.jsonl is mandatory and cannot be configured"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads explicit optional runtime_log exporter config", async () => {
    const root = await tempWorkflowRoot();
    try {
      await writeMinimalWorkflow(root, "code-review", [
        "observability:",
        "  exporters:",
        "    runtime_log:",
        "      enabled: false",
        "      required: false"
      ]);

      const definition = await loadWorkflowDefinition(root, "code-review");

      expect(definition.observability.exporters.runtime_log).toEqual({
        enabled: false,
        required: false
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Flue exporter aliases out of the generic workflow definition", async () => {
    const root = await tempWorkflowRoot();
    try {
      await writeMinimalWorkflow(root, "code-review", [
        "observability:",
        "  exporters:",
        "    flue_log:",
        "      enabled: false"
      ]);

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code: "config_schema_invalid"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown observability exporters", async () => {
    const root = await tempWorkflowRoot();
    try {
      await writeMinimalWorkflow(root, "code-review", [
        "observability:",
        "  exporters:",
        "    otel:",
        "      enabled: true"
      ]);

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code: "config_schema_invalid"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads explicit artifact plans and defaults required to true", async () => {
    const root = await tempWorkflowRoot();
    try {
      await writeWorkflowGraph(root, [
        "nodes:",
        "  - id: preflight",
        "    type: built_in",
        "    uses: preflight",
        "    artifacts:",
        "      - path: final-report.json",
        "        source: $.steps.preflight.json",
        "        format: json",
        "      - path: final-report.md",
        "        source: $.steps.preflight.markdown",
        "        format: markdown",
        "        required: true",
        ""
      ]);

      await expect(loadWorkflowDefinition(root, "code-review")).resolves.toMatchObject({
        graph: {
          nodes: [
            {
              id: "preflight",
              artifacts: [
                {
                  path: "final-report.json",
                  source: "$.steps.preflight.json",
                  format: "json",
                  required: true
                },
                {
                  path: "final-report.md",
                  source: "$.steps.preflight.markdown",
                  format: "markdown",
                  required: true
                }
              ]
            }
          ]
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["duplicate artifact paths", ["  - id: second", "    type: built_in", "    uses: collect_repo_context", "    artifacts:", "      - path: shared.json", "        source: $.steps.second", "        format: json"], "workflow_artifact_path_duplicate"],
    ["artifact path traversal", [], "path_security_violation", "../escape.json"],
    ["absolute artifact path", [], "path_security_violation", "/tmp/escape.json"]
  ])("rejects %s", async (_name, extraNodeLines, code, artifactPath = "shared.json") => {
    const root = await tempWorkflowRoot();
    try {
      await writeWorkflowGraph(root, [
        "nodes:",
        "  - id: preflight",
        "    type: built_in",
        "    uses: preflight",
        "    artifacts:",
        `      - path: ${artifactPath}`,
        "        source: $.steps.preflight",
        "        format: json",
        ...extraNodeLines,
        ""
      ]);

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["outside steps", "$.invocation", "workflow_artifact_source_invalid"],
    ["unknown step id", "$.steps.missing", "workflow_artifact_source_unknown_step"],
    ["another step id", "$.steps.other", "workflow_artifact_source_wrong_step"],
    ["wildcard", "$.steps.*.json", "workflow_artifact_source_invalid"],
    ["filter", "$.steps.preflight[?(@.ok)]", "workflow_artifact_source_invalid"],
    ["recursive descent", "$..markdown", "workflow_artifact_source_invalid"],
    ["script expression", "$.steps.preflight[(@.length-1)]", "workflow_artifact_source_invalid"],
    ["empty source", "", "workflow_artifact_source_invalid"],
    ["bracket notation", "$.steps.preflight['json']", "workflow_artifact_source_invalid"],
    ["unsafe segment", "$.steps.preflight.bad.segment$", "workflow_artifact_source_invalid"]
  ])("rejects artifact source with %s", async (_name, source, code) => {
    const root = await tempWorkflowRoot();
    try {
      await writeWorkflowGraph(root, [
        "nodes:",
        "  - id: preflight",
        "    type: built_in",
        "    uses: preflight",
        "    artifacts:",
        "      - path: output.json",
        `        source: ${JSON.stringify(source)}`,
        "        format: json",
        "  - id: other",
        "    type: built_in",
        "    uses: collect_repo_context",
        ""
      ]);

      await expect(loadWorkflowDefinition(root, "code-review")).rejects.toMatchObject({
        code
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses explicit positive execution metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-workflow-"));
    try {
      await mkdir(path.join(root, "explicit"), { recursive: true });
      await writeFile(
        path.join(root, "explicit", "workflow.yaml"),
        [
          "id: explicit",
          "type: workflow",
          "mode: git_managed_read_only",
          "input_schema: input.schema.json",
          "output_schema: output.schema.json",
          "graph: graph.yaml",
          "execution:",
          "  max_concurrency: 3",
          "  lock_timeout_ms: 1000",
          ""
        ].join("\n")
      );
      await writeFile(
        path.join(root, "explicit", "graph.yaml"),
        [
          "nodes:",
          "  - id: preflight",
          "    type: built_in",
          "    uses: preflight",
          ""
        ].join("\n")
      );

      const definition = await loadWorkflowDefinition(root, "explicit");
      expect(definition.execution).toEqual({
        max_concurrency: 3,
        lock_timeout_ms: 1000
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
