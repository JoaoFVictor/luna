import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runConfiguredWorkflow } from "../../src/core/configured-workflow/runner.js";
import {
  prepareImplementationWorktree,
  type ImplementationWorktreeRecord
} from "../../src/core/write-mode/worktree.js";
import type { Invocation } from "../../src/core/router/invocation.js";
import type { WorkspaceRecord } from "../../src/core/write-mode/types.js";
import type { WorktreeDiff } from "../../src/core/git/diff/worktree-diff.js";
import { testAgentRuntimeFromStep } from "./configured-workflow-runner-test-helpers.js";
import { providerAwareWorkflowDependencies } from "./provider-aware-workflow-dependencies.js";

const repoRoot = process.cwd();

const jiraInvocation: Invocation = {
  version: "2026-06",
  source: "jira",
  event: "issue",
  action: "selected",
  target: { type: "workflow", id: "implementation" },
  repository: {
    provider: "github",
    owner: "octo-org",
    name: "hello-world"
  },
  subject: {
    type: "jira_issue",
    id: "ABC-123",
    title: "Fix checkout validation",
    url: "https://company.atlassian.net/browse/ABC-123"
  },
  payload: {
    jira: {
      instance_id: "company",
      description: "Reject invalid checkout payloads.",
      acceptance_criteria: "Invalid payloads fail validation.",
      status: "To Do",
      issue_type: "Task"
    }
  }
};

const planeInvocation: Invocation = {
  version: "2026-06",
  source: "plane",
  event: "issue",
  action: "selected",
  target: { type: "workflow", id: "implementation" },
  repository: {
    provider: "github",
    owner: "octo-org",
    name: "hello-world"
  },
  subject: {
    type: "plane_issue",
    id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
    title: "Fix checkout validation",
    url: "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
  },
  payload: {
    plane: {
      instance_id: "company",
      workspace_slug: "company",
      project_id: "24f9b7",
      issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
      sequence_id: 42,
      description: "Reject invalid checkout payloads.",
      status: "Backlog",
      priority: "high",
      labels: ["bug"]
    }
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
      "  - id: hello-world",
      "    provider: github",
      "    owner: octo-org",
      "    name: hello-world",
      `    path: ${JSON.stringify(path.join(root, "repo"))}`,
      "    remote: origin",
      "    expected_remote_urls:",
      "      - git@github.com:octo-org/hello-world.git",
      "      - https://github.com/octo-org/hello-world.git",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "routing.yaml"),
    [
      "type: router",
      "version: \"2026-06\"",
      "rules:",
      "  - id: implementation",
      "    when:",
      "      expression: \"$exists($.invocation.target)\"",
      "    target: $.invocation.target",
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
      "  change_request:",
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

async function readRunJson(
  root: string,
  runId: string,
  name: string
): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(root, "artifacts", "implementation", runId, name),
      "utf8"
    )
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

function concurrentBarrier(expected: number, message: string): {
  enter: () => Promise<number>;
  maxWaiting: () => number;
} {
  let waiting = 0;
  let maxWaiting = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    maxWaiting: () => maxWaiting,
    enter: async () => {
      waiting += 1;
      maxWaiting = Math.max(maxWaiting, waiting);
      if (waiting === expected) {
        release?.();
      }

      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          released,
          new Promise<void>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error(message)), 500);
          })
        ]);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }

      return waiting;
    }
  };
}

describe("implementation workflow e2e", () => {
  it("runs the implementation workflow for a Plane issue invocation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-implementation-e2e-"));

    try {
      await writeTestConfig(root);

      const workspace: ImplementationWorktreeRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared",
        repository_id: "hello-world",
        branch: "feature/plane-42-fix-checkout-validation",
        remote: "origin",
        base_ref: "main",
        base_sha: "base-sha"
      };

      const result = await runConfiguredWorkflow({
        invocation: planeInvocation,
        configRoot: root,
        workflowsRoot: path.join(repoRoot, "workflows"),
        agentsRoot: path.join(repoRoot, "agents"),
        dependencies: providerAwareWorkflowDependencies({
          createRunIdentity: () => ({
            run_id: "run-1",
            workflow_id: "implementation",
            attempt: 1,
            source: "plane",
            event: "issue",
            action: "selected",
            route_target: { type: "workflow", id: "implementation" },
            subject: {
              type: "plane_issue",
              id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
            },
            started_at: "2026-06-20T00:00:00.000Z"
          }),
          builtInStepDependencies: {
            runPreflight: vi.fn(async () => ({ status: "ok" })),
            prepareImplementationWorktree: vi.fn(async () => {
              await mkdir(workspace.path, { recursive: true });
              return workspace;
            }),
            collectWorktreeDiff: vi.fn(async () => ({
              files: [],
              untracked_files: [],
              untracked_summaries: [],
              staged_diff: "",
              unstaged_diff: "",
              staged_diff_truncated: false,
              unstaged_diff_truncated: false,
              max_diff_bytes: 200000
            })),
            commitChanges: vi.fn(async () => ({
              enabled: false,
              skipped: true,
              reason: "disabled"
            })),
            pushBranch: vi.fn(async () => ({
              enabled: false,
              skipped: true,
              reason: "disabled"
            })),
            changeRequest: {
              providers: {
                get: vi.fn(() => {
                  throw new Error("disabled change request should not resolve provider");
                })
              }
            }
          },
          agentRuntime: testAgentRuntimeFromStep(async ({ agent, input }) => {
            const taskInput = input as {
              task_context: Record<string, unknown>;
            };
            if (agent.id === "implementation-planner") {
              expect(taskInput.task_context).toMatchObject({
                implementation_title: "Plane #42: Fix checkout validation",
                change_request_body: "Reject invalid checkout payloads.",
                plane: {
                  sequence_id: 42,
                  status: "Backlog"
                }
              });

              return {
                summary: "Add checkout validation.",
                steps: ["Update validation", "Run tests"],
                risks: ["Existing checkout behavior"]
              };
            }

            if (agent.id === "change-reviewer") {
              return { summary: "No findings.", findings: [] };
            }

            return {
              status: "accepted",
              summary: "Implementation accepted.",
              blocking_reasons: [],
              recommended_action: "continue"
            };
          }),
          runGatedAgentLoopStep: vi.fn(async () => ({
            status: "passed",
            attempts_exhausted: false,
            attempts: [],
            validation: { passed: true, commands: [] },
            final_validation: { passed: true, commands: [] },
            gates: [
              { id: "validation", type: "validation_commands", passed: true },
              { id: "review", type: "agent", passed: true },
              { id: "acceptance", type: "agent", passed: true }
            ],
            result: {
              status: "passed",
              diff_summary: {
                files: [],
                untracked_files: [],
                untracked_summaries: [],
                staged_diff: "",
                unstaged_diff: "",
                staged_diff_truncated: false,
                unstaged_diff_truncated: false,
                max_diff_bytes: 200000
              },
              review: { summary: "No findings.", findings: [] },
              acceptance: {
                status: "accepted",
                summary: "Implementation accepted.",
                blocking_reasons: [],
                recommended_action: "continue"
              }
            }
          })),
          cleanupWorktree: vi.fn(async () => {
            throw new Error("cleanup should not run when commit is disabled");
          })
        })
      });

      expect(result.status).toBe("success");
      await expect(readJson(root, "task-context.json")).resolves.toMatchObject({
        implementation_title: "Plane #42: Fix checkout validation",
        implementation_subject: {
          key: "42",
          title: "Fix checkout validation"
        },
        change_request_body: "Reject invalid checkout payloads.",
        plane: {
          issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
          sequence_id: 42,
          status: "Backlog"
        }
      });
      await expect(readJson(root, "final-report.json")).resolves.toMatchObject({
        task: {
          provider: "plane",
          key: "42",
          id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
          title: "Fix checkout validation",
          status: "Backlog"
        },
        plane: {
          issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
          sequence_id: 42,
          workspace_slug: "company",
          project_id: "24f9b7"
        },
        repository: {
          provider: "github",
          owner: "octo-org",
          name: "hello-world"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps three concurrent same-subject implementation runs in distinct artifacts, branches, and worktrees", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-implementation-e2e-"));

    try {
      await writeTestConfig(root);
      const branchByWorktreePath = new Map<string, string>();
      const allocatedBranches = new Set<string>();
      const allocatedWorktreePaths = new Set<string>();
      const baseSha = "1111111111111111111111111111111111111111";
      const fakeRunGit = vi.fn(async (cwd: string, args: readonly string[]) => {
        if (args[0] === "rev-parse") {
          return `${baseSha}\n`;
        }

        if (args[0] === "worktree" && args[1] === "add") {
          const branch = String(args[3]);
          const worktreePath = String(args[4]);
          if (allocatedBranches.has(branch)) {
            throw new Error(`duplicate worktree branch: ${branch}`);
          }

          if (allocatedWorktreePaths.has(worktreePath)) {
            throw new Error(`duplicate worktree path: ${worktreePath}`);
          }

          allocatedBranches.add(branch);
          allocatedWorktreePaths.add(worktreePath);
          branchByWorktreePath.set(worktreePath, branch);
          await mkdir(worktreePath, { recursive: true });
          return "";
        }

        if (args[0] === "branch" && args[1] === "--show-current") {
          return `${branchByWorktreePath.get(cwd) ?? ""}\n`;
        }

        return "";
      });
      const runIds = new Set<string>();
      const artifactDirectories = new Set<string>();
      const workspacePaths = new Set<string>();
      const branches = new Set<string>();
      const concurrentRuns = concurrentBarrier(
        3,
        "three same-subject implementation runs did not overlap"
      );

      const results = await Promise.all(
        ["one", "two", "three"].map(async (nonce) =>
          await runConfiguredWorkflow({
            invocation: jiraInvocation,
            configRoot: root,
            workflowsRoot: path.join(repoRoot, "workflows"),
            agentsRoot: path.join(repoRoot, "agents"),
            nonceFactory: () => nonce,
            dependencies: providerAwareWorkflowDependencies({
              now: () => new Date("2026-06-20T00:00:00.000Z"),
              builtInStepDependencies: {
                runPreflight: vi.fn(async () => ({ status: "ok" })),
                prepareImplementationWorktree: async (options) =>
                  await prepareImplementationWorktree({
                    ...options,
                    runGit: fakeRunGit
                  }),
                collectWorktreeDiff: vi.fn(async () => ({
                  files: [],
                  untracked_files: [],
                  untracked_summaries: [],
                  staged_diff: "",
                  unstaged_diff: "",
                  staged_diff_truncated: false,
                  unstaged_diff_truncated: false,
                  max_diff_bytes: 200000
                })),
                commitChanges: vi.fn(async () => ({
                  enabled: false,
                  skipped: true,
                  reason: "disabled"
                })),
                pushBranch: vi.fn(async () => ({
                  enabled: false,
                  skipped: true,
                  reason: "disabled"
                })),
                changeRequest: {
                  providers: {
                    get: vi.fn(() => {
                      throw new Error("disabled change request should not resolve provider");
                    })
                  }
                },
                buildImplementationReportJson: vi.fn((input) => ({
                  status: input.status,
                  branch: input.branch,
                  worktree: input.worktree,
                  validation: input.validation,
                  commit: input.commit,
                  push: input.push,
                  change_request: input.changeRequest,
                  trusted_host_local: input.trustedHostLocal
                })),
                buildImplementationReportMarkdown: vi.fn((input) =>
                  [
                    "# Implementation",
                    `Status: ${input.status}`,
                    `Worktree: ${input.worktree.path}`
                  ].join("\n")
                )
              },
              agentRuntime: testAgentRuntimeFromStep(async ({ agent }) => {
                if (agent.id === "implementation-planner") {
                  await concurrentRuns.enter();
                  return {
                    summary: "Add checkout validation.",
                    steps: ["Update validation", "Run tests"],
                    risks: ["Existing checkout behavior"]
                  };
                }

                if (agent.id === "change-reviewer") {
                  return { summary: "No findings.", findings: [] };
                }

                return {
                  status: "accepted",
                  summary: "Implementation accepted.",
                  blocking_reasons: [],
                  recommended_action: "approve"
                };
              }),
              runGatedAgentLoopStep: vi.fn(async () => ({
              status: "passed",
              attempts_exhausted: false,
              attempts: [],
              validation: { passed: true },
              final_validation: { passed: true },
              gates: [
                { id: "validation", type: "validation_commands", passed: true },
                { id: "review", type: "agent", passed: true },
                { id: "acceptance", type: "agent", passed: true }
              ],
              result: {
                status: "passed",
                diff_summary: {
                  files: [],
                  untracked_files: [],
                  untracked_summaries: [],
                  staged_diff: "",
                  unstaged_diff: "",
                  staged_diff_truncated: false,
                  unstaged_diff_truncated: false,
                  max_diff_bytes: 200000
                },
                review: { summary: "No findings.", findings: [] },
                acceptance: {
                  status: "accepted",
                  summary: "Implementation accepted.",
                  blocking_reasons: [],
                  recommended_action: "approve"
                }
              }
            })),
              cleanupWorktree: vi.fn(async () => {
                throw new Error("cleanup should not run when commit is disabled");
              })
            })
          })
        )
      );

      for (const result of results) {
        expect(result.status).toBe("success");
        if (result.status !== "success") {
          throw new Error("Expected success result");
        }

        runIds.add(result.run.run_id);
        artifactDirectories.add(
          path.join(root, "artifacts", "implementation", result.run.run_id)
        );

        const workspace = (await readRunJson(
          root,
          result.run.run_id,
          "workspace.json"
        )) as ImplementationWorktreeRecord;
        const finalReport = (await readRunJson(
          root,
          result.run.run_id,
          "final-report.json"
        )) as { branch: string; worktree: { path: string } };

        workspacePaths.add(workspace.path);
        branches.add(workspace.branch);
        expect(finalReport.worktree.path).toBe(workspace.path);
        expect(finalReport.branch).toBe(workspace.branch);
        await expect(
          pathExists(
            path.join(
              root,
              "artifacts",
              "implementation",
              result.run.run_id,
              "implementation-result.json"
            )
          )
        ).resolves.toBe(true);
      }

      expect(runIds.size).toBe(3);
      expect(concurrentRuns.maxWaiting()).toBe(3);
      expect(artifactDirectories.size).toBe(3);
      expect(workspacePaths.size).toBe(3);
      expect(branches.size).toBe(3);
      expect(allocatedBranches.size).toBe(3);
      expect(allocatedWorktreePaths.size).toBe(3);
      expect(
        [...branches].every((branch) =>
          branch.startsWith("feature/abc-123-fix-checkout-validation-")
        )
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues after failed validation, skips release gates, and preserves the worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-implementation-e2e-"));

    try {
      await writeTestConfig(root);

      const workspace: ImplementationWorktreeRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared",
        repository_id: "hello-world",
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
        dependencies: providerAwareWorkflowDependencies({
          createRunIdentity: () => ({
            run_id: "run-1",
            workflow_id: "implementation",
            attempt: 1,
            source: "jira",
            event: "issue",
            action: "selected",
            route_target: { type: "workflow", id: "implementation" },
            subject: { type: "jira_issue", id: "ABC-123" },
            started_at: "2026-06-20T00:00:00.000Z"
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
            changeRequest: {
              providers: {
                get: vi.fn(() => {
                  throw new Error("disabled change request should not resolve provider");
                })
              }
            },
            buildImplementationReportJson: vi.fn((input) => {
              calls.push("final_implementation_report");
              return {
                status: input.status,
                worktree: input.worktree,
                validation: input.validation,
                commit: input.commit,
                push: input.push,
                change_request: input.changeRequest,
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
          agentRuntime: testAgentRuntimeFromStep(async ({ agent }) => {
            calls.push(agent.id);

            if (agent.id === "implementation-planner") {
              return {
                summary: "Add checkout validation.",
                steps: ["Update validation", "Run tests"],
                risks: ["Existing checkout behavior"]
              };
            }

            if (agent.id === "change-reviewer") {
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
              blocking_reasons: ["Tests failed"],
              recommended_action: "stop"
            };
          }),
          runGatedAgentLoopStep: vi.fn(async () => {
            calls.push("gated_agent_loop");
            return {
              status: "failed",
              attempts_exhausted: true,
              attempts: [
                {
                  attempt: 1,
                  phase: "initial",
                  validation,
                  gate_results: [
                    {
                      id: "validation",
                      type: "validation_commands",
                      passed: false
                    },
                    { id: "review", type: "agent", passed: false },
                    { id: "acceptance", type: "agent", passed: false }
                  ]
                }
              ],
              validation,
              final_validation: validation,
              gates: [
                { id: "validation", type: "validation_commands", passed: false },
                { id: "review", type: "agent", passed: false },
                { id: "acceptance", type: "agent", passed: false }
              ],
              result: {
                status: "failed",
                diff_summary: worktreeDiff,
                review: {
                  summary: "Validation is failing.",
                  findings: [
                    {
                      severity: "high",
                      title: "Validation failed",
                      description: "The implementation still fails tests."
                    }
                  ]
                },
                acceptance: {
                  status: "rejected",
                  summary: "Validation failed.",
                  blocking_reasons: ["Tests failed"],
                  recommended_action: "stop"
                }
              }
            };
          }),
          cleanupWorktree: vi.fn(async () => {
            throw new Error("cleanup should not run when commit is disabled");
          })
        })
      });

      expect(result.status).toBe("success");
      expect(calls).toEqual([
        "preflight",
        "prepare_implementation_worktree",
        "implementation-planner",
        "gated_agent_loop",
        "collect_worktree_diff",
        "commit_changes",
        "push_branch",
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
      await expect(readJson(root, "change-request.json")).resolves.toMatchObject({
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
