import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runConfiguredWorkflow } from "../../src/core/configured-workflow/runner.js";
import type { LunaEvent } from "../../src/core/observability/events.js";
import type { WorkspaceRecord } from "../../src/core/types.js";
import {
  acceptedDecision,
  artifactPath,
  deferred,
  githubRun,
  invocation,
  jiraInvocation,
  jiraRun,
  pathExists,
  readJson,
  staticRunIdentity,
  withTimeout,
  writeAgent,
  writeBaseConfig,
  writeFullCodeReviewWorkflow,
  writeImplementationConfig,
  writeImplementationWorkflow,
  writePreflightWorkflow,
  writeReviewPlannerAgent,
  writeWorkflow
} from "./configured-workflow-runner-test-helpers.js";

describe("configured workflow runner", () => {
  it("runs final_implementation_report after write-mode workspace lifecycle decision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "implementation");
      await writeImplementationWorkflow(root);
      await writeAgent(root, "change-acceptance-reviewer");
      await writeImplementationConfig(root, { commitEnabled: true });

      const preparedWorkspace: WorkspaceRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared"
      };
      const cleanedWorkspace: WorkspaceRecord = {
        ...preparedWorkspace,
        preserved: false,
        reason: "success_cleanup"
      };
      const finalReportReasons: unknown[] = [];
      const runBuiltInStep = vi.fn(
        async ({
          uses,
          state
        }: {
          uses: string;
          state: { workspace?: unknown };
        }) => {
          if (uses === "preflight") {
            return { status: "ok" };
          }

          if (uses === "prepare_implementation_worktree") {
            return preparedWorkspace;
          }

          if (uses === "run_validation_commands") {
            return { passed: true };
          }

          if (uses === "record_acceptance_decision") {
            return acceptedDecision;
          }

          if (uses === "commit_changes") {
            return { enabled: true, skipped: false, commit_sha: "abc123" };
          }

          if (uses === "push_branch") {
            return { enabled: false, skipped: true, reason: "disabled" };
          }

          if (uses === "open_change_request") {
            return { enabled: false, skipped: true, reason: "disabled" };
          }

          if (uses === "final_implementation_report") {
            finalReportReasons.push(
              (state.workspace as WorkspaceRecord | undefined)?.reason
            );
            return {
              json: { workspace: state.workspace },
              markdown: "# Implementation\n"
            };
          }

          return {};
        }
      );

      const result = await runConfiguredWorkflow({
        invocation: jiraInvocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(jiraRun),
          runBuiltInStep,
          runAgentStep: vi.fn(async () => acceptedDecision),
          cleanupWorktree: vi.fn(async () => cleanedWorkspace)
        }
      });

      expect(result.status).toBe("success");
      expect(result.workspace).toEqual(cleanedWorkspace);
      expect(finalReportReasons).toEqual(["success_cleanup"]);
      await expect(
        readJson(root, "implementation", "run-1", "final-report.json")
      ).resolves.toMatchObject({
        workspace: cleanedWorkspace
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it("cleans successful workspaces when preserve_on_success is false and rewrites final workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeFullCodeReviewWorkflow(root);
      await writeAgent(root, "review-planner");
      await writeAgent(root, "change-reviewer");
      await writeAgent(root, "change-acceptance-reviewer");

      const preparedWorkspace: WorkspaceRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared"
      };
      const cleanedWorkspace: WorkspaceRecord = {
        ...preparedWorkspace,
        preserved: false,
        reason: "success_cleanup"
      };
      const cleanupWorktree = vi.fn(async () => cleanedWorkspace);
      const finalReportWorkspaces: unknown[] = [];
      const runBuiltInStep = vi.fn(
        async ({
          uses,
          state
        }: {
          uses: string;
          state: { workspace?: unknown };
        }) => {
          if (uses === "preflight") {
            return { status: "ok" };
          }

          if (uses === "prepare_worktree") {
            return preparedWorkspace;
          }

          if (uses === "collect_repo_context") {
            return { files: [] };
          }

          if (uses === "validate_code_review_findings") {
            return { summary: "Validated", findings: [] };
          }

          if (uses === "final_code_review_report") {
            finalReportWorkspaces.push(state.workspace);
            return {
              json: { workspace: state.workspace },
              markdown: "# Review\n"
            };
          }

          return {};
        }
      );

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep,
          runAgentStep: vi.fn(async ({ agent }: { agent: { id: string } }) =>
            agent.id === "change-reviewer"
              ? { summary: "Findings", findings: [] }
              : { status: "accepted", findings_to_fix: [] }
          ),
          cleanupWorktree
        }
      });

      expect(result.status).toBe("success");
      expect(result.workspace).toEqual(cleanedWorkspace);
      expect(cleanupWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryPath: path.join(root, "repo"),
          workspaceRoot: path.join(root, "workspaces"),
          workspaceRecord: preparedWorkspace,
          persistedWorkspaceRecord: preparedWorkspace
        })
      );
      await expect(
        readJson(root, "code-review", "run-1", "workspace.json")
      ).resolves.toEqual(cleanedWorkspace);
      expect(finalReportWorkspaces).toEqual([cleanedWorkspace]);
      await expect(
        readJson(root, "code-review", "run-1", "final-report.json")
      ).resolves.toMatchObject({
        workspace: cleanedWorkspace
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a failed result when throwOnError is false and preserves failure workspaces", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeFullCodeReviewWorkflow(root);
      await writeAgent(root, "review-planner");
      await writeAgent(root, "change-reviewer");
      await writeAgent(root, "change-acceptance-reviewer");

      const preparedWorkspace: WorkspaceRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared"
      };
      const reviewError = new Error("review failed") as Error & { code: string };
      reviewError.code = "review_failed";

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        workflowsRoot: path.join(root, "workflows"),
        agentsRoot: path.join(root, "agents"),
        throwOnError: false,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) => {
            if (uses === "preflight") {
              return { status: "ok" };
            }

            if (uses === "prepare_worktree") {
              return preparedWorkspace;
            }

            if (uses === "collect_repo_context") {
              return { files: [] };
            }

            return {};
          }),
          runAgentStep: vi.fn(async ({ agent }: { agent: { id: string } }) => {
            if (agent.id === "change-reviewer") {
              throw reviewError;
            }

            return { summary: "Plan", focus_areas: [], files_to_review: [] };
          }),
          cleanupWorktree: vi.fn()
        }
      });

      const expectedWorkspace = {
        ...preparedWorkspace,
        preserved: true,
        reason: "failure_preserved"
      };
      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        throw new Error("Expected failed result");
      }
      expect(result.error).toMatchObject({
        code: "scheduler_step_failed",
        details: { step_id: "code_review", cause_code: "review_failed" }
      });
      expect(result.workspace).toEqual(expectedWorkspace);
      await expect(
        readJson(root, "code-review", "run-1", "error.json")
      ).resolves.toMatchObject({
        code: "scheduler_step_failed",
        details: { step_id: "code_review", cause_code: "review_failed" }
      });
      await expect(
        readJson(root, "code-review", "run-1", "workspace.json")
      ).resolves.toEqual(expectedWorkspace);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("acquires repository lock before failure cleanup can remove a worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeFile(
        path.join(root, "app.yaml"),
        [
          "workspace:",
          "  strategy: git_worktree",
          `  root: ${JSON.stringify(path.join(root, "workspaces"))}`,
          "  preserve_on_success: false",
          "  preserve_on_failure: false",
          "artifacts:",
          `  root: ${JSON.stringify(path.join(root, "artifacts"))}`,
          ""
        ].join("\n")
      );
      await writeFullCodeReviewWorkflow(root);
      await writeAgent(root, "review-planner");
      await writeAgent(root, "change-reviewer");
      await writeAgent(root, "change-acceptance-reviewer");

      const events: string[] = [];
      const preparedWorkspace: WorkspaceRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared"
      };
      const reviewError = new Error("review failed") as Error & { code: string };
      reviewError.code = "review_failed";

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        workflowsRoot: path.join(root, "workflows"),
        agentsRoot: path.join(root, "agents"),
        throwOnError: false,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          lockManagerFactory: () => ({
            acquire: async (resource) => {
              events.push(`acquire:${resource}`);
              return async () => {
                events.push(`release:${resource}`);
              };
            }
          }),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) => {
            if (uses === "prepare_worktree") {
              events.push(`run:${uses}`);
              return preparedWorkspace;
            }

            if (uses === "collect_repo_context") {
              return { files: [] };
            }

            return { status: "ok" };
          }),
          runAgentStep: vi.fn(async ({ agent }: { agent: { id: string } }) => {
            if (agent.id === "change-reviewer") {
              throw reviewError;
            }

            return { summary: "Plan", focus_areas: [], files_to_review: [] };
          }),
          cleanupWorktree: vi.fn(async ({ workspaceRecord }) => {
            events.push("cleanup");
            return {
              ...workspaceRecord,
              preserved: false,
              reason: "failure_cleanup"
            };
          })
        }
      });

      expect(result.status).toBe("failed");
      expect(events).toEqual([
        "acquire:repository:repo",
        "run:prepare_worktree",
        "release:repository:repo",
        "acquire:repository:repo",
        "cleanup",
        "release:repository:repo"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes success_cleanup_failed when successful workspace cleanup fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeFullCodeReviewWorkflow(root);
      await writeAgent(root, "review-planner");
      await writeAgent(root, "change-reviewer");
      await writeAgent(root, "change-acceptance-reviewer");

      const preparedWorkspace: WorkspaceRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared"
      };

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        workflowsRoot: path.join(root, "workflows"),
        agentsRoot: path.join(root, "agents"),
        throwOnError: false,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) => {
            if (uses === "preflight") {
              return { status: "ok" };
            }

            if (uses === "prepare_worktree") {
              return preparedWorkspace;
            }

            if (uses === "collect_repo_context") {
              return { files: [] };
            }

            if (uses === "validate_code_review_findings") {
              return { summary: "Validated", findings: [] };
            }

            return {};
          }),
          runAgentStep: vi.fn(async ({ agent }: { agent: { id: string } }) =>
            agent.id === "change-reviewer"
              ? { summary: "Findings", findings: [] }
              : { status: "accepted", findings_to_fix: [] }
          ),
          cleanupWorktree: vi.fn(async () => {
            const error = new Error("cleanup failed");
            throw error;
          })
        }
      });

      const expectedWorkspace = {
        ...preparedWorkspace,
        preserved: true,
        reason: "success_cleanup_failed"
      };
      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        throw new Error("Expected failed result");
      }
      expect(result.error).toMatchObject({ code: "success_cleanup_failed" });
      expect(result.workspace).toEqual(expectedWorkspace);
      await expect(
        readJson(root, "code-review", "run-1", "error.json")
      ).resolves.toMatchObject({
        code: "success_cleanup_failed"
      });
      await expect(
        readJson(root, "code-review", "run-1", "workspace.json")
      ).resolves.toEqual(expectedWorkspace);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
