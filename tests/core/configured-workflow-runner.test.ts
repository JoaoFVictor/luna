import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runConfiguredWorkflow } from "../../src/core/configured-workflow-runner.js";
import type { Invocation } from "../../src/core/types.js";

const invocation: Invocation = {
  target: "github_pr",
  owner: "octo",
  repo: "hello",
  pull_number: 123,
  base_ref: "main",
  base_repository: { owner: "octo", name: "hello", full_name: "octo/hello" },
  head_repository: { owner: "octo", name: "hello", full_name: "octo/hello" },
  references: { base_sha: "base", head_sha: "head" }
};

async function writeBaseConfig(
  root: string,
  workflowId = "code-review",
  routing: "static" | "real" = "static"
): Promise<void> {
  await mkdir(path.join(root, "workflows", workflowId), { recursive: true });
  await mkdir(path.join(root, "agents"), { recursive: true });

  await writeFile(
    path.join(root, "app.yaml"),
    [
      "workspace:",
      "  strategy: git_worktree",
      `  root: ${JSON.stringify(path.join(root, "workspaces"))}`,
      "  preserve_on_success: false",
      "  preserve_on_failure: true",
      "artifacts:",
      `  root: ${JSON.stringify(path.join(root, "artifacts"))}`,
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "repositories.yaml"),
    [
      "repositories:",
      "  - id: repo",
      "    provider: github",
      "    owner: octo",
      "    name: hello",
      `    path: ${JSON.stringify(path.join(root, "repo"))}`,
      "    remote: origin",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "routing.yaml"),
    routing === "real"
      ? [
          "routes:",
          "  - name: explicit-target",
          "    when:",
          "      has_target: true",
          "    use_target_from_input: true",
          "  - name: github-pr-code-review",
          "    when:",
          "      source: github",
          "      event_in:",
          "        - pull_request.opened",
          "        - pull_request.synchronize",
          "        - pull_request.ready_for_review",
          "    target:",
          "      type: workflow",
          `      id: ${workflowId}`,
          ""
        ].join("\n")
      : [
          "routes:",
          "  - name: github-pr-code-review",
          "    when: {}",
          "    target:",
          "      type: workflow",
          `      id: ${workflowId}`,
          ""
        ].join("\n")
  );
  await writeFile(
    path.join(root, "models.yaml"),
    [
      "model_profiles:",
      "  planner:",
      "    model: openai/gpt-5-mini",
      "    reasoning_effort: medium",
      ""
    ].join("\n")
  );
}

async function writeWorkflow(root: string): Promise<void> {
  await writeFile(
    path.join(root, "workflows", "code-review", "workflow.yaml"),
    [
      "id: code-review",
      "type: workflow",
      "mode: git_managed_read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "code-review", "graph.yaml"),
    [
      "nodes:",
      "  - id: preflight",
      "    type: built_in",
      "    uses: preflight",
      "    artifact: preflight.json",
      "  - id: repo_context",
      "    type: built_in",
      "    uses: collect_repo_context",
      "    artifact: repo-context.json",
      "    after:",
      "      - preflight",
      "  - id: review_plan",
      "    type: agent",
      "    agent: review-planner",
      "    output_schema: review_plan",
      "    artifact: review-plan.json",
      "    input:",
      "      repo_context: $.steps.repo_context",
      "    after:",
      "      - repo_context",
      ""
    ].join("\n")
  );
}

describe("configured workflow runner", () => {
  it("runs a configured workflow graph and writes artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);

      const runBuiltInStep = vi.fn(async ({ uses }: { uses: string }) => {
        if (uses === "preflight") {
          return { status: "ok" };
        }

        if (uses === "collect_repo_context") {
          return { files: [] };
        }

        return {};
      });
      const runAgentStep = vi.fn(async ({ input }: { input: unknown }) => ({
        summary: "Plan",
        focus_areas: [],
        files_to_review: [],
        input
      }));

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        workflowsRoot: path.join(root, "workflows"),
        agentsRoot: path.join(root, "agents"),
        dependencies: {
          createRunIdentity: () => ({
            run_id: "run-1",
            target: "github_pr",
            started_at: "2026-06-19T00:00:00.000Z"
          }),
          runBuiltInStep,
          runAgentStep
        }
      });

      expect(result.status).toBe("success");
      expect(result.workflow_id).toBe("code-review");
      expect(result.steps.review_plan).toMatchObject({
        summary: "Plan",
        input: { repo_context: { files: [] } }
      });
      expect(runBuiltInStep).toHaveBeenCalledTimes(2);
      expect(runAgentStep).toHaveBeenCalledTimes(1);
      await expect(
        readFile(path.join(root, "artifacts", "run-1", "invocation.json"), "utf8")
      ).resolves.toContain("github_pr");
      await expect(
        readFile(path.join(root, "artifacts", "run-1", "run.json"), "utf8")
      ).resolves.toContain("run-1");
      await expect(
        readFile(path.join(root, "artifacts", "run-1", "review-plan.json"), "utf8")
      ).resolves.toContain("Plan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps missing workflow configuration to workflow_config_read_failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "missing-workflow");

      await expect(
        runConfiguredWorkflow({
          invocation,
          configRoot: root,
          workflowsRoot: path.join(root, "workflows"),
          dependencies: {
            createRunIdentity: () => ({
              run_id: "run-1",
              target: "github_pr",
              started_at: "2026-06-19T00:00:00.000Z"
            }),
            runBuiltInStep: vi.fn(),
            runAgentStep: vi.fn()
          }
        })
      ).rejects.toMatchObject({ code: "workflow_config_read_failed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the default workflow for legacy github_pr payloads with real routing config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "code-review", "real");
      await writeWorkflow(root);

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        workflowsRoot: path.join(root, "workflows"),
        defaultWorkflowId: "code-review",
        dependencies: {
          createRunIdentity: () => ({
            run_id: "run-1",
            target: "github_pr",
            started_at: "2026-06-19T00:00:00.000Z"
          }),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) =>
            uses === "collect_repo_context" ? { files: [] } : { status: "ok" }
          ),
          runAgentStep: vi.fn(async () => ({
            summary: "Plan",
            focus_areas: [],
            files_to_review: []
          }))
        }
      });

      expect(result.status).toBe("success");
      expect(result.workflow_id).toBe("code-review");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not hide malformed explicit targets behind the default workflow", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "code-review", "real");
      await writeWorkflow(root);

      await expect(
        runConfiguredWorkflow({
          invocation: {
            ...invocation,
            target: { type: "workflow", id: "" }
          } as unknown as Invocation,
          configRoot: root,
          workflowsRoot: path.join(root, "workflows"),
          defaultWorkflowId: "code-review",
          dependencies: {
            createRunIdentity: () => ({
              run_id: "run-1",
              target: "github_pr",
              started_at: "2026-06-19T00:00:00.000Z"
            }),
            runBuiltInStep: vi.fn(),
            runAgentStep: vi.fn()
          }
        })
      ).rejects.toMatchObject({ code: "invalid_invocation" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
