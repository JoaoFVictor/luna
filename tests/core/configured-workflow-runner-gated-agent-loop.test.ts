import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runConfiguredWorkflow } from "../../src/core/configured-workflow/runner.js";
import type { LunaEvent } from "../../src/core/observability/events.js";
import type { WorkspaceRecord } from "../../src/core/write-mode/types.js";
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
  writeWorkflow,
  writeWorkflowSchemas
} from "./configured-workflow-runner-test-helpers.js";

async function writeInvalidDeferredDependencyWorkflow(
  root: string,
  workflowId = "code-review"
): Promise<void> {
  await mkdir(path.join(root, "workflows", workflowId), { recursive: true });
  await writeWorkflowSchemas(root, workflowId);
  await writeFile(
    path.join(root, "workflows", workflowId, "workflow.yaml"),
    [
      `id: ${workflowId}`,
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "capabilities:",
      "  - runtime",
      "  - artifacts",
      "nodes:",
      "  - id: final",
      "    type: built_in",
      "    uses: runtime.final_code_review_report",
      "    artifacts:",
      "      - path: final-report.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.final\"",
      "        format: json",
      "  - id: after_final",
      "    type: built_in",
      "    uses: runtime.preflight",
      "    artifacts:",
      "      - path: after-final.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.after_final\"",
      "        format: json",
      "    after:",
      "      - final",
      ""
    ].join("\n")
  );
}


async function writeTrustedWriteAgent(root: string, id: string): Promise<void> {
  const agentRoot = path.join(root, "agents", id);
  await mkdir(agentRoot, { recursive: true });

  await writeFile(
    path.join(agentRoot, "agent.yaml"),
    [
      `id: ${id}`,
      `description: ${id}`,
      "model_profile: default",
      "mode: trusted_local_write",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      ""
    ].join("\n")
  );
  await writeFile(path.join(agentRoot, "instructions.md"), `${id}\n`);
  await writeFile(
    path.join(agentRoot, "output.schema.json"),
    JSON.stringify({
      type: "object",
      additionalProperties: true
    })
  );
}


async function runImplementationLifecycleScenario({
  root,
  commitOutput,
  pushOutput = { enabled: false, skipped: true, reason: "disabled" },
  changeRequestOutput = {
    operation_id: "change-request.create",
    enabled: false,
    skipped: true,
    reason: "disabled",
    adopted: false
  }
}: {
  root: string;
  commitOutput: unknown;
  pushOutput?: unknown;
  changeRequestOutput?: unknown;
}) {
  const preparedWorkspace: WorkspaceRecord = {
    run_id: "run-1",
    path: path.join(root, "workspaces", "run-1"),
    preserved: true,
    reason: "prepared"
  };
  const cleanupWorktree = vi.fn(async ({ workspaceRecord }: { workspaceRecord: WorkspaceRecord }) => ({
    ...workspaceRecord,
    preserved: false,
    reason: "success_cleanup"
  }));
  const runBuiltInStep = vi.fn(async ({ uses }: { uses: string }) => {
    if (uses === "preflight") {
      return { status: "ok" };
    }

    if (uses === "prepare_implementation_worktree") {
      return preparedWorkspace;
    }

    if (uses === "record_implementation_validation") {
      return {
        validation: { passed: true },
        acceptance: acceptedDecision
      };
    }

    if (uses === "commit_changes") {
      return commitOutput;
    }

    if (uses === "push_branch") {
      return pushOutput;
    }

    if (uses === "change-request.create") {
      return changeRequestOutput;
    }

    if (uses === "final_implementation_report") {
      return {
        json: {},
        markdown: "# Implementation\n"
      };
    }

    return {};
  });

  const result = await runConfiguredWorkflow({
    invocation: jiraInvocation,
    configRoot: root,
    dependencies: {
      createRunIdentity: staticRunIdentity(jiraRun),
      runBuiltInStep,
      runGatedAgentLoopStep: vi.fn(async () => ({
        status: "passed",
        attempts_exhausted: false,
        attempts: [],
        validation: { passed: true },
        final_validation: { passed: true },
        gates: [
          { id: "validation", type: "validation_commands", passed: true },
          { id: "acceptance", type: "agent", passed: true }
        ],
        result: {
          status: "passed",
          diff_summary: { files: [] },
          acceptance: acceptedDecision
        }
      })),
      cleanupWorktree
    }
  });

  return { result, cleanupWorktree };
}

async function writeGatedAgentLoopWorkflow(
  root: string,
  options: {
    commands?: string;
    maxOutputBytes?: string;
    repairAttempts?: string;
    extraMetadata?: string[];
  } = {}
): Promise<void> {
  await mkdir(path.join(root, "workflows", "implementation"), {
    recursive: true
  });
  await writeWorkflowSchemas(root, "implementation");
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
    path.join(root, "workflows", "implementation", "workflow.yaml"),
    [
      "id: implementation",
      "type: workflow",
      "mode: trusted_local_write",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "capabilities:",
      "  - runtime",
      "  - quality-gates",
      "  - agents",
      "  - artifacts",
      ...(options.extraMetadata ?? []),
      "nodes:",
      "  - id: preflight",
      "    type: built_in",
      "    uses: runtime.preflight",
      "    artifacts:",
      "      - path: preflight.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.preflight\"",
      "        format: json",
      "  - id: workspace",
      "    type: built_in",
      "    uses: runtime.prepare_implementation_worktree",
      "    input:",
      "      subject:",
      "        key:",
      "          expression: \"$.invocation.subject.id\"",
      "        title:",
      "          expression: \"$.invocation.subject.title\"",
      "    artifacts:",
      "      - path: workspace.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.workspace\"",
      "        format: json",
      "    after:",
      "      - preflight",
      "  - id: implementation",
      "    type: pattern",
      "    uses: quality-gates.gated_agent_loop",
      "    worker: code-implementer",
      "    artifacts:",
      "      - path: implementation-attempts.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.implementation.attempts\"",
      "        format: json",
      "      - path: validation.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.implementation.validation\"",
      "        format: json",
      "      - path: implementation-result.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.implementation.result\"",
      "        format: json",
      "    input:",
      "      invocation:",
      "        expression: \"$.invocation\"",
      "      workspace:",
      "        expression: \"$.workspace\"",
      "      preflight:",
      "        expression: \"$.steps.preflight\"",
      "    gates:",
      "      - id: validation",
      "        type: quality-gates.validation_commands",
      "        input:",
      "          commands:",
      `            expression: \"${options.commands ?? "$.config.implementation.validation.commands"}\"`,
      "          max_output_bytes:",
      `            expression: \"${options.maxOutputBytes ?? "$.config.implementation.validation.max_output_bytes"}\"`,
      "    repair:",
      "      attempts:",
      `        expression: \"${options.repairAttempts ?? "$.config.implementation.validation.repair_attempts"}\"`,
      "    after:",
      "      - workspace",
      "  - id: implementation_validation",
      "    type: built_in",
      "    uses: runtime.record_implementation_validation",
      "    input:",
      "      implementation:",
      "        expression: \"$.steps.implementation\"",
      "    artifacts:",
      "      - path: implementation-validation.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.implementation_validation\"",
      "        format: json",
      "    after:",
      "      - implementation",
      "  - id: diff",
      "    type: built_in",
      "    uses: runtime.collect_worktree_diff",
      "    artifacts:",
      "      - path: diff.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.diff\"",
      "        format: json",
      "    after:",
      "      - implementation_validation",
      ""
    ].join("\n")
  );
}

describe("configured workflow runner", () => {
  it("runs gated_agent_loop with resolved inputs and writes mapped artifacts before later nodes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "implementation");
      await writeGatedAgentLoopWorkflow(root, {
        extraMetadata: ["subagent_policy:", "  allow_write: true"]
      });
      await writeImplementationConfig(root);
      await writeTrustedWriteAgent(root, "code-implementer");

      const preparedWorkspace: WorkspaceRecord = {
        run_id: "run-1",
        path: path.join(root, "workspaces", "run-1"),
        preserved: true,
        reason: "prepared"
      };
      const calls: string[] = [];
      const loopOutput = {
        status: "failed",
        attempts_exhausted: true,
        attempts: [{ attempt: 1, phase: "initial" }],
        validation: { passed: false },
        final_validation: { passed: false },
        gates: [],
        result: { status: "failed" }
      };
      const runBuiltInStep = vi.fn(async ({ uses }: { uses: string }) => {
        calls.push(uses);

        if (uses === "preflight") {
          return { status: "ok" };
        }

        if (uses === "prepare_implementation_worktree") {
          return preparedWorkspace;
        }

        if (uses === "record_implementation_validation") {
          return {
            validation: { passed: false },
            acceptance: acceptedDecision
          };
        }

        if (uses === "collect_worktree_diff") {
          return { files: ["src/index.ts"] };
        }

        return {};
      });
      const runGatedAgentLoopStep = vi.fn(async () => {
        calls.push("gated_agent_loop");
        return loopOutput;
      });

      const result = await runConfiguredWorkflow({
        invocation: jiraInvocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(jiraRun),
          runBuiltInStep,
          runGatedAgentLoopStep,
          cleanupWorktree: vi.fn(async ({ workspaceRecord }) => ({
            ...workspaceRecord,
            preserved: false,
            reason: "success_cleanup"
          }))
        }
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error("Expected success result");
      }
      expect(calls).toEqual([
        "preflight",
        "prepare_implementation_worktree",
        "gated_agent_loop",
        "record_implementation_validation",
        "collect_worktree_diff"
      ]);
      expect(runGatedAgentLoopStep).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({
            id: "code-implementer",
            mode: "trusted_local_write"
          }),
          agentsRoot: path.join(root, "agents"),
          modelProfiles: {
            default: {
              model: "openai-codex/gpt-5.4-mini",
              reasoning_effort: "medium"
            }
          },
          workflowSubagentPolicy: { allow_write: true },
          input: {
            invocation: jiraInvocation,
            workspace: preparedWorkspace,
            preflight: { status: "ok" }
          },
          sandbox: {
            type: "trusted_host_local",
            cwd: preparedWorkspace.path,
            env_allowlist: []
          },
          gates: [
            {
              id: "validation",
              type: "validation_commands",
              commands: [{ cmd: "npm", args: ["test"], timeout_ms: 120000 }],
              max_output_bytes: 200000
            }
          ],
          repair: {
            attempts: 1
          }
        })
      );
      expect(result.steps.implementation).toBe(loopOutput);
      expect(result.steps.diff).toEqual({ files: ["src/index.ts"] });
      await expect(
        readJson(root, "implementation", "run-1", "implementation-attempts.json")
      ).resolves.toEqual(loopOutput.attempts);
      await expect(
        readJson(root, "implementation", "run-1", "validation.json")
      ).resolves.toEqual(loopOutput.validation);
      await expect(
        readJson(root, "implementation", "run-1", "implementation-result.json")
      ).resolves.toEqual(loopOutput.result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns agent_runtime_missing when an agent dependency is not configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      await expect(
        runConfiguredWorkflow({
          invocation,
          configRoot: root,
          dependencies: {
            createRunIdentity: staticRunIdentity(githubRun),
            runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) =>
              uses === "collect_repo_context"
                ? { files: [] }
                : { status: "ok" }
            )
          }
        })
      ).rejects.toMatchObject({
        code: "scheduler_step_failed",
        details: {
          step_id: "review_plan",
          cause_code: "agent_runtime_missing"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns gated_agent_loop_runner_missing when an gated_agent_loop dependency is not configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "implementation");
      await writeGatedAgentLoopWorkflow(root);
      await writeImplementationConfig(root);
      await writeTrustedWriteAgent(root, "code-implementer");

      const result = await runConfiguredWorkflow({
        invocation: jiraInvocation,
        configRoot: root,
        throwOnError: false,
        dependencies: {
          createRunIdentity: staticRunIdentity(jiraRun),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) =>
            uses === "prepare_implementation_worktree"
              ? {
                  run_id: "run-1",
                  path: path.join(root, "workspaces", "run-1"),
                  preserved: true,
                  reason: "prepared"
                }
              : { status: "ok" }
          )
        }
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        throw new Error("Expected failed result");
      }
      expect(result.error).toMatchObject({
        code: "scheduler_step_failed",
        details: {
          step_id: "implementation",
          cause_code: "gated_agent_loop_runner_missing"
        }
      });
      await expect(
        readJson(root, "implementation", "run-1", "error.json")
      ).resolves.toMatchObject({
        code: "scheduler_step_failed",
        details: {
          step_id: "implementation",
          cause_code: "gated_agent_loop_runner_missing"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "unstructured commands",
      workflowOptions: { commands: "$.steps.preflight.commands" },
      preflight: { commands: ["npm test"] },
      code: "gated_agent_loop_validation_commands_invalid"
    },
    {
      name: "max_output_bytes string",
      workflowOptions: { maxOutputBytes: "$.steps.preflight.max_output_bytes" },
      preflight: { max_output_bytes: "200000" },
      code: "gated_agent_loop_validation_max_output_bytes_invalid"
    },
    {
      name: "repair attempts string",
      workflowOptions: { repairAttempts: "$.steps.preflight.repair_attempts" },
      preflight: { repair_attempts: "1" },
      code: "gated_agent_loop_repair_attempts_invalid"
    }
  ])(
    "rejects invalid resolved gated_agent_loop $name",
    async ({ workflowOptions, preflight, code }) => {
      const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

      try {
        await writeBaseConfig(root, "implementation");
        await writeGatedAgentLoopWorkflow(root, workflowOptions);
        await writeImplementationConfig(root);
        await writeTrustedWriteAgent(root, "code-implementer");

        const runGatedAgentLoopStep = vi.fn();
        const result = await runConfiguredWorkflow({
          invocation: jiraInvocation,
          configRoot: root,
          throwOnError: false,
          dependencies: {
            createRunIdentity: staticRunIdentity(jiraRun),
            runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) => {
              if (uses === "preflight") {
                return preflight;
              }

              if (uses === "prepare_implementation_worktree") {
                return {
                  run_id: "run-1",
                  path: path.join(root, "workspaces", "run-1"),
                  preserved: true,
                  reason: "prepared"
                };
              }

              return { status: "ok" };
            }),
            runGatedAgentLoopStep
          }
        });

        expect(result.status).toBe("failed");
        if (result.status !== "failed") {
          throw new Error("Expected failed result");
        }
        expect(result.error).toMatchObject({
          code: "scheduler_step_failed",
          details: { step_id: "implementation", cause_code: code }
        });
        expect(runGatedAgentLoopStep).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    {
      name: "commit",
      config: { commitEnabled: true },
      outputs: {
        commitOutput: {
          enabled: true,
          skipped: true,
          reason: "commit disabled by gate"
        }
      },
      reason: "commit_skipped_or_failed"
    },
    {
      name: "push",
      config: { commitEnabled: true, pushEnabled: true },
      outputs: {
        commitOutput: { enabled: true, skipped: false, commit_sha: "abc123" },
        pushOutput: {
          enabled: true,
          skipped: true,
          reason: "push disabled by gate"
        }
      },
      reason: "push_skipped_or_failed"
    },
    {
      name: "pull request",
      config: {
        commitEnabled: true,
        pushEnabled: true,
        changeRequestEnabled: true
      },
      outputs: {
        commitOutput: { enabled: true, skipped: false, commit_sha: "abc123" },
        pushOutput: {
          enabled: true,
          skipped: false,
          remote: "origin",
          branch: "feature/abc-123"
        },
        changeRequestOutput: {
          operation_id: "change-request.create",
          enabled: true,
          skipped: true,
          reason: "pull request disabled by gate",
          adopted: false
        }
      },
      reason: "change_request_skipped_or_failed"
    }
  ])(
    "preserves write-mode workspace when enabled $name output is skipped",
    async ({ config, outputs, reason }) => {
      const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

      try {
        await writeBaseConfig(root, "implementation");
        await writeImplementationWorkflow(root);
        await writeAgent(root, "code-implementer");
        await writeAgent(root, "change-acceptance-reviewer");
        await writeImplementationConfig(root, config);

        const { result, cleanupWorktree } = await runImplementationLifecycleScenario({
          root,
          ...outputs
        });

        expect(result.status).toBe("success");
        if (result.status !== "success") {
          throw new Error("Expected success result");
        }
        expect(result.workspace).toMatchObject({
          preserved: true,
          reason
        });
        expect(cleanupWorktree).not.toHaveBeenCalled();
        await expect(
          readJson(root, "implementation", "run-1", "workspace.json")
        ).resolves.toMatchObject({
          preserved: true,
          reason
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("fails before main graph execution when a non-deferred node depends on final report", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeInvalidDeferredDependencyWorkflow(root);
      const runBuiltInStep = vi.fn(async () => ({ status: "ok" }));

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        throwOnError: false,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep
        }
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        throw new Error("Expected failed result");
      }
      expect(result.error).toMatchObject({
        code: "workflow_deferred_dependency_invalid"
      });
      expect(runBuiltInStep).not.toHaveBeenCalled();
      await expect(
        readJson(root, "code-review", "run-1", "error.json")
      ).resolves.toMatchObject({
        code: "workflow_deferred_dependency_invalid"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
