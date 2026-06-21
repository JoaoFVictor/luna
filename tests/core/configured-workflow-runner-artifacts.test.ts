import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runConfiguredWorkflow } from "../../src/core/configured-workflow-runner.js";
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
  it("preserves code-review artifacts for the configured graph", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeFullCodeReviewWorkflow(root);
      await writeAgent(root, "review-planner");
      await writeAgent(root, "change-reviewer");
      await writeAgent(root, "change-acceptance-reviewer");

      const workspace: WorkspaceRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared"
      };
      const runBuiltInStep = vi.fn(async ({ uses }: { uses: string }) => {
        if (uses === "preflight") {
          return { status: "ok" };
        }

        if (uses === "prepare_worktree") {
          return workspace;
        }

        if (uses === "collect_repo_context") {
          return { files: [] };
        }

        if (uses === "validate_code_review_findings") {
          return { summary: "Validated", findings: [] };
        }

        if (uses === "final_code_review_report") {
          return {
            json: { findings: [], workspace },
            markdown: "# Review\n"
          };
        }

        return {};
      });
      const runAgentStep = vi.fn(async ({ agent }: { agent: { id: string } }) => {
        if (agent.id === "review-planner") {
          return { summary: "Plan", focus_areas: [], files_to_review: [] };
        }

        if (agent.id === "change-reviewer") {
          return { summary: "Findings", findings: [] };
        }

        return { status: "accepted", findings_to_fix: [] };
      });

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep,
          runAgentStep,
          cleanupWorktree: vi.fn(async ({ workspaceRecord }) => ({
            ...workspaceRecord,
            preserved: false,
            reason: "success_cleanup"
          }))
        }
      });

      expect(result.status).toBe("success");
      await Promise.all(
        [
          "invocation.json",
          "run.json",
          "preflight.json",
          "workspace.json",
          "repo-context.json",
          "review-plan.json",
          "code-review-findings.json",
          "acceptance-review.json",
          "final-report.json",
          "final-report.md"
        ].map(async (name) => {
          await expect(
            pathExists(artifactPath(root, "code-review", "run-1", name))
          ).resolves.toBe(true);
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses injected built-in metadata instead of hardcoded built-in names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeFullCodeReviewWorkflow(root);
      await writeAgent(root, "review-planner");
      await writeAgent(root, "change-reviewer");
      await writeAgent(root, "change-acceptance-reviewer");

      const workspace: WorkspaceRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared"
      };
      const runBuiltInStep = vi.fn(async ({ uses }: { uses: string }) => {
        if (uses === "preflight") {
          return { status: "ok" };
        }

        if (uses === "prepare_worktree") {
          return workspace;
        }

        if (uses === "collect_repo_context") {
          return { files: [] };
        }

        if (uses === "validate_code_review_findings") {
          return { summary: "Validated", findings: [] };
        }

        if (uses === "final_code_review_report") {
          return {
            json: { findings: [], workspace },
            markdown: "# Review\n"
          };
        }

        return {};
      });
      const cleanupWorktree = vi.fn(async ({ workspaceRecord }) => ({
        ...workspaceRecord,
        preserved: false,
        reason: "success_cleanup"
      }));

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          builtInStepRegistry: {
            require: (name: string) => ({
              name,
              metadata: {},
              run: async () => ({})
            })
          },
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
      expect(runBuiltInStep).toHaveBeenCalledWith(
        expect.objectContaining({ uses: "final_code_review_report" })
      );
      expect(cleanupWorktree).not.toHaveBeenCalled();
      expect(result.workspace).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures and defers built-ins when injected metadata requests it", async () => {
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
              json: { findings: [], workspace: state.workspace },
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
          builtInStepRegistry: {
            require: (name: string) => ({
              name,
              metadata:
                name === "prepare_worktree"
                  ? { capturesWorkspace: true }
                  : name === "final_code_review_report"
                    ? { deferredLifecycle: "final_report" }
                    : {},
              run: async () => ({})
            })
          },
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
      expect(cleanupWorktree).toHaveBeenCalledTimes(1);
      expect(finalReportWorkspaces).toEqual([cleanedWorkspace]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
