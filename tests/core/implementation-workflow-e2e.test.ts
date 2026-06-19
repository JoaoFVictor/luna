import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runConfiguredWorkflow } from "../../src/core/configured-workflow-runner.js";
import type { ImplementationWorktreeRecord } from "../../src/core/implementation-worktree-manager.js";
import type { Invocation, WorkspaceRecord } from "../../src/core/types.js";
import type { WorktreeDiff } from "../../src/core/worktree-diff-collector.js";

const repoRoot = process.cwd();

const jiraInvocation: Invocation = {
  target: "jira_task",
  workflow: "implementation",
  jira: {
    instance_id: "company",
    issue_key: "ABC-123",
    url: "https://company.atlassian.net/browse/ABC-123",
    summary: "Fix checkout validation",
    description: "Reject invalid checkout payloads.",
    acceptance_criteria: "Invalid payloads fail validation.",
    status: "To Do",
    issue_type: "Task"
  },
  repository: {
    provider: "github",
    owner: "swinggo-dev",
    name: "swg-front-nuxt"
  }
};

async function writeTestConfig(root: string): Promise<void> {
  await mkdir(path.join(root, "repo"), { recursive: true });
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
      "  - id: swg-front-nuxt",
      "    provider: github",
      "    owner: swinggo-dev",
      "    name: swg-front-nuxt",
      `    path: ${JSON.stringify(path.join(root, "repo"))}`,
      "    remote: origin",
      "    expected_remote_urls:",
      "      - git@github.com:swinggo-dev/swg-front-nuxt.git",
      "      - https://github.com/swinggo-dev/swg-front-nuxt.git",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "routing.yaml"),
    [
      "routes:",
      "  - name: implementation",
      "    when:",
      "      has_target: true",
      "    use_target_from_input: true",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "models.yaml"),
    [
      "model_profiles:",
      "  default:",
      "    model: openai-codex/gpt-5.4-mini",
      "    reasoning_effort: medium",
      "  deep:",
      "    model: openai-codex/gpt-5.4",
      "    reasoning_effort: high",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "implementation.yaml"),
    [
      "implementation:",
      "  branch_pattern: feature/{slug}",
      "  commit:",
      "    enabled: false",
      "  push:",
      "    enabled: false",
      "    remote: origin",
      "  pull_request:",
      "    enabled: false",
      "    provider: github",
      "    draft: true",
      "    base_ref: main",
      "  sandbox:",
      "    type: trusted_host_local",
      "    env_allowlist: []",
      "  validation:",
      "    repair_attempts: 1",
      "    max_output_bytes: 200000",
      "    commands:",
      "      - cmd: npm",
      "        args: [\"test\"]",
      "        timeout_ms: 120000",
      "      - cmd: npm",
      "        args: [\"run\", \"typecheck\"]",
      "        timeout_ms: 120000",
      ""
    ].join("\n")
  );
}

async function readJson(root: string, name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(root, "artifacts", "implementation", "run-1", name), "utf8")
  ) as unknown;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("implementation workflow e2e", () => {
  it("continues after failed validation, skips release gates, and preserves the worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-implementation-e2e-"));

    try {
      await writeTestConfig(root);

      const workspace: ImplementationWorktreeRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared",
        repository_id: "swg-front-nuxt",
        branch: "feature/abc-123-fix-checkout-validation",
        remote: "origin",
        base_ref: "main",
        base_sha: "base-sha"
      };
      const worktreeDiff: WorktreeDiff = {
        files: [
          {
            path: "src/checkout.ts",
            status: "modified",
            index_status: " ",
            worktree_status: "M"
          }
        ],
        untracked_files: [],
        untracked_summaries: [],
        staged_diff: "",
        unstaged_diff: "@@ fake diff",
        staged_diff_truncated: false,
        unstaged_diff_truncated: false,
        max_diff_bytes: 200000
      };
      const validation = {
        passed: false,
        commands: [
          {
            cmd: "npm",
            args: ["test"],
            exit_code: 1,
            stdout: "",
            stderr: "failing test",
            stdout_truncated: false,
            stderr_truncated: false,
            duration_ms: 10,
            timed_out: false
          }
        ]
      };
      const calls: string[] = [];

      const result = await runConfiguredWorkflow({
        invocation: jiraInvocation,
        configRoot: root,
        workflowsRoot: path.join(repoRoot, "workflows"),
        agentsRoot: path.join(repoRoot, "agents"),
        dependencies: {
          createRunIdentity: () => ({
            run_id: "run-1",
            target: "jira_task",
            started_at: "2026-06-19T00:00:00.000Z"
          }),
          builtInStepDependencies: {
            runPreflight: vi.fn(async () => {
              calls.push("preflight");
              return { status: "ok" };
            }),
            prepareImplementationWorktree: vi.fn(async () => {
              calls.push("prepare_implementation_worktree");
              await mkdir(workspace.path, { recursive: true });
              return workspace;
            }),
            collectWorktreeDiff: vi.fn(async () => {
              calls.push("collect_worktree_diff");
              return worktreeDiff;
            }),
            commitChanges: vi.fn(async ({ validation: gateValidation }) => {
              calls.push("commit_changes");
              expect(gateValidation).toEqual(validation);
              return { enabled: false, skipped: true, reason: "disabled" };
            }),
            pushBranch: vi.fn(async () => {
              calls.push("push_branch");
              return { enabled: false, skipped: true, reason: "disabled" };
            }),
            openPullRequest: vi.fn(async () => {
              calls.push("open_pull_request");
              return { enabled: false, skipped: true, reason: "disabled" };
            }),
            buildImplementationReportJson: vi.fn((input) => {
              calls.push("final_implementation_report");
              return {
                status: input.status,
                worktree: input.worktree,
                validation: input.validation,
                commit: input.commit,
                push: input.push,
                pull_request: input.pullRequest,
                trusted_host_local: input.trustedHostLocal
              };
            }),
            buildImplementationReportMarkdown: vi.fn((input) =>
              [
                "# Implementation",
                `Status: ${input.status}`,
                `Worktree: ${input.worktree.path}`,
                "Trusted-host local execution was used."
              ].join("\n")
            )
          },
          runAgentStep: vi.fn(async ({ agent }) => {
            calls.push(agent.id);

            if (agent.id === "implementation-planner") {
              return {
                summary: "Add checkout validation.",
                steps: ["Update validation", "Run tests"],
                risks: ["Existing checkout behavior"]
              };
            }

            if (agent.id === "implementation-reviewer") {
              return {
                summary: "Validation is failing.",
                findings: [
                  {
                    severity: "high",
                    title: "Validation failed",
                    description: "The implementation still fails tests."
                  }
                ]
              };
            }

            return {
              status: "rejected",
              summary: "Validation failed.",
              blocking_reasons: ["Tests failed"]
            };
          }),
          runAgentLoopStep: vi.fn(async () => {
            calls.push("agent_loop");
            return {
              status: "failed",
              attempts_exhausted: true,
              attempts: [{ attempt: 1, phase: "initial", validation }],
              validation,
              final_validation: validation,
              result: {
                status: "failed"
              }
            };
          }),
          cleanupWorktree: vi.fn(async () => {
            throw new Error("cleanup should not run when commit is disabled");
          })
        }
      });

      expect(result.status).toBe("success");
      expect(calls).toEqual([
        "preflight",
        "prepare_implementation_worktree",
        "implementation-planner",
        "agent_loop",
        "collect_worktree_diff",
        "implementation-reviewer",
        "implementation-acceptance-reviewer",
        "commit_changes",
        "push_branch",
        "open_pull_request",
        "final_implementation_report"
      ]);
      expect(result.workspace).toMatchObject({
        path: workspace.path,
        preserved: true,
        reason: "commit_disabled"
      });
      await expect(readJson(root, "validation.json")).resolves.toEqual(
        validation
      );
      await expect(readJson(root, "commit.json")).resolves.toMatchObject({
        skipped: true,
        reason: "disabled"
      });
      await expect(readJson(root, "push.json")).resolves.toMatchObject({
        skipped: true,
        reason: "disabled"
      });
      await expect(readJson(root, "pull-request.json")).resolves.toMatchObject({
        skipped: true,
        reason: "disabled"
      });
      await expect(readJson(root, "workspace.json")).resolves.toMatchObject({
        preserved: true,
        reason: "commit_disabled"
      });
      await expect(readJson(root, "final-report.json")).resolves.toMatchObject({
        status: "validation_failed",
        worktree: {
          path: workspace.path,
          preserved: true,
          reason: "commit_disabled"
        },
        trusted_host_local: true
      });
      expect(await pathExists(workspace.path)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
