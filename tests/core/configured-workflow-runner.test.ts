import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runConfiguredWorkflow } from "../../src/core/configured-workflow-runner.js";
import type { RunIdentityOptions } from "../../src/core/run-identity.js";
import type { Invocation, RunIdentity, WorkspaceRecord } from "../../src/core/types.js";

const invocation: Invocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  action: "selected",
  target: { type: "workflow", id: "code-review" },
  repository: { provider: "github", owner: "octo", name: "hello" },
  subject: { type: "pull_request", id: "42" },
  references: { base_ref: "main", base_sha: "base", head_sha: "head" },
  payload: {
    pull_request: { number: 42 },
    base_repository: { owner: "octo", name: "hello", full_name: "octo/hello" },
    head_repository: { owner: "octo", name: "hello", full_name: "octo/hello" }
  }
};

const jiraInvocation: Invocation = {
  version: "2026-06",
  source: "jira",
  event: "issue",
  action: "selected",
  target: { type: "workflow", id: "implementation" },
  repository: {
    provider: "github",
    owner: "octo",
    name: "hello"
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

const githubRun: RunIdentity = {
  run_id: "run-1",
  workflow_id: "code-review",
  attempt: 1,
  source: "github",
  event: "pull_request",
  action: "selected",
  route_target: { type: "workflow", id: "code-review" },
  subject: { type: "pull_request", id: "42" },
  started_at: "2026-06-20T00:00:00.000Z"
};

const jiraRun: RunIdentity = {
  run_id: "run-1",
  workflow_id: "implementation",
  attempt: 1,
  source: "jira",
  event: "issue",
  action: "selected",
  route_target: { type: "workflow", id: "implementation" },
  subject: { type: "jira_issue", id: "ABC-123" },
  started_at: "2026-06-20T00:00:00.000Z"
};

function staticRunIdentity(run: RunIdentity) {
  return (_invocation: Invocation, options: RunIdentityOptions): RunIdentity => ({
    ...run,
    workflow_id: options.workflowId,
    attempt: options.attempt,
    started_at: options.date.toISOString()
  });
}

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
          "      event: pull_request",
          "      action_in:",
          "        - opened",
          "        - synchronize",
          "        - ready_for_review",
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
      "  default:",
      "    model: openai-codex/gpt-5.4-mini",
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

async function writeToyWorkflow(root: string): Promise<void> {
  await mkdir(path.join(root, "workflows", "toy-review"), { recursive: true });
  await writeFile(
    path.join(root, "routing.yaml"),
    [
      "routes:",
      "  - name: toy-review",
      "    when: {}",
      "    target:",
      "      type: workflow",
      "      id: toy-review",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "toy-review", "workflow.yaml"),
    [
      "id: toy-review",
      "type: workflow",
      "mode: git_managed_read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "toy-review", "graph.yaml"),
    [
      "nodes:",
      "  - id: preflight",
      "    type: built_in",
      "    uses: preflight",
      "    artifact: preflight.json",
      "  - id: toy_agent",
      "    type: agent",
      "    agent: review-planner",
      "    output_schema: review_plan",
      "    artifact: toy-agent.json",
      "    input:",
      "      preflight: $.steps.preflight",
      "    after:",
      "      - preflight",
      ""
    ].join("\n")
  );
}

async function writeConfigInputWorkflow(root: string): Promise<void> {
  await mkdir(path.join(root, "workflows", "config-input-review"), {
    recursive: true
  });
  await writeFile(
    path.join(root, "workflows", "config-input-review", "workflow.yaml"),
    [
      "id: config-input-review",
      "type: workflow",
      "mode: git_managed_read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "config-input-review", "graph.yaml"),
    [
      "nodes:",
      "  - id: config_probe",
      "    type: built_in",
      "    uses: preflight",
      "    artifact: config-probe.json",
      "    input:",
      "      commands: $.config.implementation.validation.commands",
      ""
    ].join("\n")
  );
}

async function writeImplementationConfig(
  root: string,
  options: {
    commitEnabled?: boolean;
    pushEnabled?: boolean;
    pullRequestEnabled?: boolean;
  } = {}
): Promise<void> {
  await writeFile(
    path.join(root, "implementation.yaml"),
    [
      "implementation:",
      "  branch_pattern: feature/{slug}",
      "  commit:",
      `    enabled: ${options.commitEnabled === true ? "true" : "false"}`,
      "  push:",
      `    enabled: ${options.pushEnabled === true ? "true" : "false"}`,
      "    remote: origin",
      "  pull_request:",
      `    enabled: ${options.pullRequestEnabled === true ? "true" : "false"}`,
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
      ""
    ].join("\n")
  );
}

async function writeImplementationWorkflow(root: string): Promise<void> {
  await mkdir(path.join(root, "workflows", "implementation"), {
    recursive: true
  });
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
    path.join(root, "workflows", "implementation", "workflow.yaml"),
    [
      "id: implementation",
      "type: workflow",
      "mode: git_managed_write",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "implementation", "graph.yaml"),
    [
      "nodes:",
      "  - id: preflight",
      "    type: built_in",
      "    uses: preflight",
      "    artifact: preflight.json",
      "  - id: workspace",
      "    type: built_in",
      "    uses: prepare_implementation_worktree",
      "    artifact: workspace.json",
      "    after:",
      "      - preflight",
      "  - id: validation",
      "    type: built_in",
      "    uses: run_validation_commands",
      "    artifact: validation.json",
      "    after:",
      "      - workspace",
      "  - id: acceptance",
      "    type: built_in",
      "    uses: collect_task_context",
      "    artifact: acceptance.json",
      "    after:",
      "      - validation",
      "  - id: commit",
      "    type: built_in",
      "    uses: commit_changes",
      "    artifact: commit.json",
      "    after:",
      "      - acceptance",
      "  - id: push",
      "    type: built_in",
      "    uses: push_branch",
      "    artifact: push.json",
      "    after:",
      "      - commit",
      "  - id: pull_request",
      "    type: built_in",
      "    uses: open_pull_request",
      "    artifact: pull-request.json",
      "    after:",
      "      - push",
      "  - id: final_report",
      "    type: built_in",
      "    uses: final_implementation_report",
      "    artifact:",
      "      json: final-report.json",
      "      markdown: final-report.md",
      "    after:",
      "      - pull_request",
      ""
    ].join("\n")
  );
}

async function writeFullCodeReviewWorkflow(root: string): Promise<void> {
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
      "  - id: workspace",
      "    type: built_in",
      "    uses: prepare_worktree",
      "    artifact: workspace.json",
      "    after:",
      "      - preflight",
      "  - id: repo_context",
      "    type: built_in",
      "    uses: collect_repo_context",
      "    artifact: repo-context.json",
      "    after:",
      "      - workspace",
      "  - id: review_plan",
      "    type: agent",
      "    agent: review-planner",
      "    output_schema: review_plan",
      "    artifact: review-plan.json",
      "    input:",
      "      repo_context: $.steps.repo_context",
      "    after:",
      "      - repo_context",
      "  - id: code_review",
      "    type: agent",
      "    agent: change-reviewer",
      "    output_schema: code_review_findings",
      "    artifact: code-review-findings.json",
      "    input:",
      "      review_plan: $.steps.review_plan",
      "    after:",
      "      - review_plan",
      "  - id: validate_findings",
      "    type: built_in",
      "    uses: validate_code_review_findings",
      "    artifact: code-review-findings.json",
      "    input:",
      "      repo_context: $.steps.repo_context",
      "      findings: $.steps.code_review",
      "    after:",
      "      - code_review",
      "  - id: acceptance",
      "    type: agent",
      "    agent: change-acceptance-reviewer",
      "    output_schema: acceptance_decision",
      "    artifact: acceptance-review.json",
      "    input:",
      "      findings: $.steps.validate_findings",
      "    after:",
      "      - validate_findings",
      "  - id: final_report",
      "    type: built_in",
      "    uses: final_code_review_report",
      "    artifact:",
      "      json: final-report.json",
      "      markdown: final-report.md",
      "    input:",
      "      findings: $.steps.validate_findings",
      "      acceptance: $.steps.acceptance",
      "    after:",
      "      - acceptance",
      ""
    ].join("\n")
  );
}

async function writeReviewPlannerAgent(root: string): Promise<void> {
  const agentRoot = path.join(root, "agents", "review-planner");
  await mkdir(agentRoot, { recursive: true });

  await writeFile(
    path.join(agentRoot, "agent.yaml"),
    [
      "id: review-planner",
      "description: Plans repository review",
      "model_profile: default",
      "mode: read_only",
      "instructions_file: instructions.md",
      "output_schema: output.schema.json",
      ""
    ].join("\n")
  );
  await writeFile(path.join(agentRoot, "instructions.md"), "Plan the review.\n");
  await writeFile(
    path.join(agentRoot, "output.schema.json"),
    JSON.stringify({
      type: "object",
      additionalProperties: true
    })
  );
}

async function writeAgent(root: string, id: string): Promise<void> {
  const agentRoot = path.join(root, "agents", id);
  await mkdir(agentRoot, { recursive: true });

  await writeFile(
    path.join(agentRoot, "agent.yaml"),
    [
      `id: ${id}`,
      `description: ${id}`,
      "model_profile: default",
      "mode: read_only",
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

async function writeTrustedWriteAgent(root: string, id: string): Promise<void> {
  const agentRoot = path.join(root, "agents", id);
  await mkdir(agentRoot, { recursive: true });

  await writeFile(
    path.join(agentRoot, "agent.yaml"),
    [
      `id: ${id}`,
      `description: ${id}`,
      "model_profile: default",
      "mode: trusted_host_local_write",
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

function artifactPath(
  root: string,
  workflowId: string,
  runId: string,
  name: string
): string {
  return path.join(root, "artifacts", workflowId, runId, name);
}

async function readJson(
  root: string,
  workflowId: string,
  runId: string,
  name: string
): Promise<unknown> {
  return JSON.parse(
    await readFile(artifactPath(root, workflowId, runId, name), "utf8")
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

async function runImplementationLifecycleScenario({
  root,
  commitOutput,
  pushOutput = { enabled: false, skipped: true, reason: "disabled" },
  pullRequestOutput = { enabled: false, skipped: true, reason: "disabled" }
}: {
  root: string;
  commitOutput: unknown;
  pushOutput?: unknown;
  pullRequestOutput?: unknown;
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

    if (uses === "run_validation_commands") {
      return { passed: true };
    }

    if (uses === "collect_task_context") {
      return { status: "accepted" };
    }

    if (uses === "commit_changes") {
      return commitOutput;
    }

    if (uses === "push_branch") {
      return pushOutput;
    }

    if (uses === "open_pull_request") {
      return pullRequestOutput;
    }

    if (uses === "final_implementation_report") {
      return {
        json: { workspace: undefined },
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
      cleanupWorktree
    }
  });

  return { result, cleanupWorktree };
}

async function writeAgentLoopWorkflow(
  root: string,
  options: {
    commands?: string;
    maxOutputBytes?: string;
    repairAttempts?: string;
  } = {}
): Promise<void> {
  await mkdir(path.join(root, "workflows", "implementation"), {
    recursive: true
  });
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
    path.join(root, "workflows", "implementation", "workflow.yaml"),
    [
      "id: implementation",
      "type: workflow",
      "mode: git_managed_write",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", "implementation", "graph.yaml"),
    [
      "nodes:",
      "  - id: preflight",
      "    type: built_in",
      "    uses: preflight",
      "    artifact: preflight.json",
      "  - id: workspace",
      "    type: built_in",
      "    uses: prepare_implementation_worktree",
      "    artifact: workspace.json",
      "    after:",
      "      - preflight",
      "  - id: implementation",
      "    type: agent_loop",
      "    agent: code-implementer",
      "    output_schema: implementation_result",
      "    artifact:",
      "      attempts: implementation-attempts.json",
      "      validation: validation.json",
      "      result: implementation-result.json",
      "    input:",
      "      invocation: $.invocation",
      "      workspace: $.workspace",
      "      preflight: $.steps.preflight",
      "    sandbox:",
      "      type: trusted_host_local",
      "      cwd: $.workspace.path",
      "      env_allowlist: []",
      "    validation:",
      `      commands: ${options.commands ?? "$.config.implementation.validation.commands"}`,
      `      max_output_bytes: ${options.maxOutputBytes ?? "$.config.implementation.validation.max_output_bytes"}`,
      "    repair:",
      `      attempts: ${options.repairAttempts ?? "$.config.implementation.validation.repair_attempts"}`,
      "    after:",
      "      - workspace",
      "  - id: diff",
      "    type: built_in",
      "    uses: collect_worktree_diff",
      "    artifact: diff.json",
      "    after:",
      "      - implementation",
      ""
    ].join("\n")
  );
}

describe("configured workflow runner", () => {
  it("routes and uses routed workflow options when creating the final run identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const fixedDate = new Date("2026-06-20T12:34:56.789Z");
      const createRunIdentity = vi.fn(
        (receivedInvocation: Invocation, options: RunIdentityOptions): RunIdentity => ({
          run_id: `run-${options.workflowId}`,
          ...(options.flueRunId === undefined
            ? {}
            : { flue_run_id: options.flueRunId }),
          workflow_id: options.workflowId,
          attempt: options.attempt,
          source: receivedInvocation.source,
          event: receivedInvocation.event,
          ...(receivedInvocation.action === undefined
            ? {}
            : { action: receivedInvocation.action }),
          ...(receivedInvocation.target === undefined
            ? {}
            : { route_target: receivedInvocation.target }),
          ...(receivedInvocation.subject === undefined
            ? {}
            : {
                subject: {
                  type: receivedInvocation.subject.type,
                  id: receivedInvocation.subject.id
                }
              }),
          started_at: options.date.toISOString()
        })
      );

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        flueRunId: "flue-1",
        nonceFactory: () => "nonce-1",
        dependencies: {
          now: () => fixedDate,
          createRunIdentity,
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
      expect(createRunIdentity).toHaveBeenCalledWith(
        invocation,
        expect.objectContaining({
          workflowId: "code-review",
          flueRunId: "flue-1",
          nonce: "nonce-1",
          attempt: 1,
          date: fixedDate
        })
      );
      await expect(
        readJson(root, "code-review", "run-code-review", "run.json")
      ).resolves.toMatchObject({
        workflow_id: "code-review",
        flue_run_id: "flue-1"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes pre-route failures under the failed workflow namespace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const fixedDate = new Date("2026-06-20T00:00:00.000Z");
      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        throwOnError: false,
        nonceFactory: () => "pre",
        dependencies: {
          now: () => fixedDate,
          routeInvocation: () => {
            throw Object.assign(new Error("No route matched"), {
              code: "route_not_found"
            });
          }
        }
      });

      expect(result.status).toBe("failed");
      expect(result.workflow_id).toBe("_failed");
      await expect(
        pathExists(path.join(root, "artifacts", "_failed"))
      ).resolves.toBe(true);
      await expect(
        readJson(root, "_failed", result.run.run_id, "run.json")
      ).resolves.toMatchObject({
        workflow_id: "_failed"
      });
      await expect(
        readJson(root, "_failed", result.run.run_id, "error.json")
      ).resolves.toMatchObject({
        code: "route_not_found",
        run_id: result.run.run_id
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits routed and succeeded logger events for successful runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const runLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      };

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        flueRunId: "flue-log",
        nonceFactory: () => "log",
        runLogger,
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z"),
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-log",
            flue_run_id: "flue-log"
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
      expect(runLogger.info).toHaveBeenCalledWith("luna.workflow.routed", {
        "luna.run_id": "run-log",
        "luna.flue_run_id": "flue-log",
        "luna.workflow_id": "code-review"
      });
      expect(runLogger.info).toHaveBeenCalledWith("luna.run.succeeded", {
        "luna.run_id": "run-log",
        "luna.flue_run_id": "flue-log",
        "luna.workflow_id": "code-review"
      });
      expect(runLogger.error).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let logger failures mask successful runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        flueRunId: "flue-log",
        nonceFactory: () => "log",
        runLogger: {
          info: vi.fn(() => {
            throw new Error("logger unavailable");
          }),
          warn: vi.fn(),
          error: vi.fn()
        },
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z"),
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-log-throw",
            flue_run_id: "flue-log"
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

      expect(result).toMatchObject({
        status: "success",
        run: { run_id: "run-log-throw" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits failed logger events for failures after a run exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);

      const runLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      };

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        throwOnError: false,
        flueRunId: "flue-fail",
        nonceFactory: () => "fail",
        runLogger,
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z"),
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-fail",
            flue_run_id: "flue-fail"
          }),
          runBuiltInStep: vi.fn(async () => {
            throw Object.assign(new Error("Preflight failed"), {
              code: "preflight_failed"
            });
          })
        }
      });

      expect(result.status).toBe("failed");
      expect(runLogger.error).toHaveBeenCalledWith("luna.run.failed", {
        "luna.run_id": "run-fail",
        "luna.flue_run_id": "flue-fail",
        "luna.workflow_id": "code-review",
        "error.code": "preflight_failed"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let logger failures mask workflow failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        throwOnError: false,
        flueRunId: "flue-fail",
        nonceFactory: () => "fail",
        runLogger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(() => {
            throw new Error("logger unavailable");
          })
        },
        dependencies: {
          now: () => new Date("2026-06-20T00:00:00.000Z"),
          createRunIdentity: staticRunIdentity({
            ...githubRun,
            run_id: "run-fail-logger",
            flue_run_id: "flue-fail"
          }),
          runBuiltInStep: vi.fn(async () => {
            throw Object.assign(new Error("Preflight failed"), {
              code: "preflight_failed"
            });
          })
        }
      });

      expect(result).toMatchObject({
        status: "failed",
        error: { code: "preflight_failed" },
        run: { run_id: "run-fail-logger" }
      });
      await expect(
        readJson(root, "code-review", "run-fail-logger", "error.json")
      ).resolves.toMatchObject({
        code: "preflight_failed",
        run_id: "run-fail-logger"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes flattened implementation config references to built-in node input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "config-input-review");
      await writeConfigInputWorkflow(root);
      await writeImplementationConfig(root);

      const runBuiltInStep = vi.fn(async () => ({ status: "ok" }));

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep
        }
      });

      expect(result.status).toBe("success");
      expect(runBuiltInStep).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            commands: [{ cmd: "npm", args: ["test"], timeout_ms: 120000 }]
          }
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs final_implementation_report after write-mode workspace lifecycle decision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "implementation");
      await writeImplementationWorkflow(root);
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

          if (uses === "collect_task_context") {
            return { status: "accepted" };
          }

          if (uses === "commit_changes") {
            return { enabled: true, skipped: false, commit_sha: "abc123" };
          }

          if (uses === "push_branch") {
            return { enabled: false, skipped: true, reason: "disabled" };
          }

          if (uses === "open_pull_request") {
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

  it("runs agent_loop with resolved inputs and writes mapped artifacts before later nodes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "implementation");
      await writeAgentLoopWorkflow(root);
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

        if (uses === "collect_worktree_diff") {
          return { files: ["src/index.ts"] };
        }

        return {};
      });
      const runAgentLoopStep = vi.fn(async () => {
        calls.push("agent_loop");
        return loopOutput;
      });

      const result = await runConfiguredWorkflow({
        invocation: jiraInvocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(jiraRun),
          runBuiltInStep,
          runAgentLoopStep,
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
        "agent_loop",
        "collect_worktree_diff"
      ]);
      expect(runAgentLoopStep).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({
            id: "code-implementer",
            mode: "trusted_host_local_write"
          }),
          agentsRoot: path.join(root, "agents"),
          modelProfiles: {
            default: {
              model: "openai-codex/gpt-5.4-mini",
              reasoning_effort: "medium"
            }
          },
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
          validation: {
            commands: [{ cmd: "npm", args: ["test"], timeout_ms: 120000 }],
            max_output_bytes: 200000
          },
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

  it("returns agent_loop_runner_missing when an agent_loop dependency is not configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "implementation");
      await writeAgentLoopWorkflow(root);
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
      expect(result.error).toMatchObject({ code: "agent_loop_runner_missing" });
      await expect(
        readJson(root, "implementation", "run-1", "error.json")
      ).resolves.toMatchObject({
        code: "agent_loop_runner_missing"
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
      code: "agent_loop_validation_commands_invalid"
    },
    {
      name: "max_output_bytes string",
      workflowOptions: { maxOutputBytes: "$.steps.preflight.max_output_bytes" },
      preflight: { max_output_bytes: "200000" },
      code: "agent_loop_validation_max_output_bytes_invalid"
    },
    {
      name: "repair attempts string",
      workflowOptions: { repairAttempts: "$.steps.preflight.repair_attempts" },
      preflight: { repair_attempts: "1" },
      code: "agent_loop_repair_attempts_invalid"
    }
  ])(
    "rejects invalid resolved agent_loop $name",
    async ({ workflowOptions, preflight, code }) => {
      const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

      try {
        await writeBaseConfig(root, "implementation");
        await writeAgentLoopWorkflow(root, workflowOptions);
        await writeImplementationConfig(root);
        await writeTrustedWriteAgent(root, "code-implementer");

        const runAgentLoopStep = vi.fn();
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
            runAgentLoopStep
          }
        });

        expect(result.status).toBe("failed");
        if (result.status !== "failed") {
          throw new Error("Expected failed result");
        }
        expect(result.error).toMatchObject({ code });
        expect(runAgentLoopStep).not.toHaveBeenCalled();
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
        commitOutput: { enabled: true, skipped: false }
      },
      reason: "commit_skipped_or_failed"
    },
    {
      name: "push",
      config: { commitEnabled: true, pushEnabled: true },
      outputs: {
        commitOutput: { enabled: true, skipped: false, commit_sha: "abc123" },
        pushOutput: { enabled: true, skipped: false }
      },
      reason: "push_skipped_or_failed"
    },
    {
      name: "pull request",
      config: {
        commitEnabled: true,
        pushEnabled: true,
        pullRequestEnabled: true
      },
      outputs: {
        commitOutput: { enabled: true, skipped: false, commit_sha: "abc123" },
        pushOutput: {
          enabled: true,
          skipped: false,
          remote: "origin",
          branch: "feature/abc-123"
        },
        pullRequestOutput: { enabled: true, skipped: false }
      },
      reason: "pull_request_skipped_or_failed"
    }
  ])(
    "preserves write-mode workspace when enabled $name output lacks success evidence",
    async ({ config, outputs, reason }) => {
      const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

      try {
        await writeBaseConfig(root, "implementation");
        await writeImplementationWorkflow(root);
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
            json: { report_path: "placeholder", findings: [], workspace },
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
            json: { report_path: "placeholder", findings: [], workspace },
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
              json: { report_path: "placeholder", findings: [], workspace: state.workspace },
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
                    ? { deferUntilAfterWorkspaceLifecycle: true }
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
          state: { reportPath?: string; workspace?: unknown };
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
              json: { workspace: state.workspace, report_path: state.reportPath },
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
      expect(result.error).toMatchObject({ code: "review_failed" });
      expect(result.workspace).toEqual(expectedWorkspace);
      await expect(
        readJson(root, "code-review", "run-1", "error.json")
      ).resolves.toMatchObject({
        code: "review_failed"
      });
      await expect(
        readJson(root, "code-review", "run-1", "workspace.json")
      ).resolves.toEqual(expectedWorkspace);
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

  it("runs a configured workflow graph and writes artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

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
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep,
          runAgentStep
        }
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error("Expected success result");
      }
      expect(result.workflow_id).toBe("code-review");
      expect(result.steps.review_plan).toMatchObject({
        summary: "Plan",
        input: { repo_context: { files: [] } }
      });
      expect(runBuiltInStep).toHaveBeenCalledTimes(2);
      expect(runAgentStep).toHaveBeenCalledTimes(1);
      await expect(
        readFile(
          artifactPath(root, "code-review", "run-1", "invocation.json"),
          "utf8"
        )
      ).resolves.toContain('"source": "github"');
      await expect(
        readFile(
          artifactPath(root, "code-review", "run-1", "run.json"),
          "utf8"
        )
      ).resolves.toContain("run-1");
      await expect(
        readFile(
          artifactPath(root, "code-review", "run-1", "review-plan.json"),
          "utf8"
        )
      ).resolves.toContain("Plan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes artifacts under the routed workflow id namespace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep: async ({ uses }: { uses: string }) =>
            uses === "collect_repo_context" ? { files: [] } : { status: "ok" },
          runAgentStep: async () => ({
            summary: "Plan",
            focus_areas: [],
            files_to_review: []
          })
        }
      });

      await expect(
        readFile(
          path.join(
            root,
            "artifacts",
            "code-review",
            "run-1",
            "review-plan.json"
          ),
          "utf8"
        )
      ).resolves.toContain("Plan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a new configured workflow without a workflow-specific TypeScript module", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeToyWorkflow(root);
      await writeReviewPlannerAgent(root);

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep: vi.fn(async () => ({ status: "ok" })),
          runAgentStep: vi.fn(async ({ input }: { input: unknown }) => ({
            summary: "Toy workflow executed",
            focus_areas: [],
            files_to_review: [],
            input
          }))
        }
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error("Expected success result");
      }
      expect(result.workflow_id).toBe("toy-review");
      expect(result.steps.toy_agent).toMatchObject({
        summary: "Toy workflow executed",
        input: { preflight: { status: "ok" } }
      });
      await expect(
        readFile(
          artifactPath(root, "toy-review", "run-1", "toy-agent.json"),
          "utf8"
        )
      ).resolves.toContain("Toy workflow executed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes agent definition, model options, and resolved input to agent steps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const repoContext = { files: ["src/index.ts"], summary: "existing" };
      const runAgentStep = vi.fn(async () => ({
        summary: "Plan",
        focus_areas: [],
        files_to_review: []
      }));

      await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        workflowsRoot: path.join(root, "workflows"),
        agentsRoot: path.join(root, "agents"),
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) =>
            uses === "collect_repo_context" ? repoContext : { status: "ok" }
          ),
          runAgentStep
        }
      });

      expect(runAgentStep).toHaveBeenCalledTimes(1);
      expect(runAgentStep).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({
            id: "review-planner",
            model_profile: "default"
          }),
          model: {
            model: "openai-codex/gpt-5.4-mini",
            thinkingLevel: "medium"
          },
          agentsRoot: path.join(root, "agents"),
          modelProfiles: {
            default: {
              model: "openai-codex/gpt-5.4-mini",
              reasoning_effort: "medium"
            }
          },
          input: {
            repo_context: repoContext
          }
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws model_profile_missing when an agent references an unknown model profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root);
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);
      await writeFile(
        path.join(root, "models.yaml"),
        [
          "model_profiles:",
          "  deep:",
          "    model: openai-codex/gpt-5.4-mini",
          "    reasoning_effort: medium",
          ""
        ].join("\n")
      );

      await expect(
        runConfiguredWorkflow({
          invocation,
          configRoot: root,
          workflowsRoot: path.join(root, "workflows"),
          agentsRoot: path.join(root, "agents"),
          dependencies: {
            createRunIdentity: staticRunIdentity(githubRun),
            runBuiltInStep: vi.fn(async ({ uses }: { uses: string }) =>
              uses === "collect_repo_context" ? { files: [] } : { status: "ok" }
            ),
            runAgentStep: vi.fn()
          }
        })
      ).rejects.toMatchObject({ code: "model_profile_missing" });
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
            createRunIdentity: staticRunIdentity(githubRun),
            runBuiltInStep: vi.fn(),
            runAgentStep: vi.fn()
          }
        })
      ).rejects.toMatchObject({ code: "workflow_config_read_failed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns failed result and writes error.json for missing workflow when throwOnError is false", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "missing-workflow");

      const result = await runConfiguredWorkflow({
        invocation,
        configRoot: root,
        workflowsRoot: path.join(root, "workflows"),
        throwOnError: false,
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
          runBuiltInStep: vi.fn(),
          runAgentStep: vi.fn()
        }
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        throw new Error("Expected failed result");
      }
      expect(result.workflow_id).toBe("missing-workflow");
      expect(result.error).toMatchObject({
        code: "workflow_config_read_failed"
      });
      await expect(
        readJson(root, "missing-workflow", "run-1", "error.json")
      ).resolves.toMatchObject({
        code: "workflow_config_read_failed"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes GitHub pull request events through normal routing rules", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-configured-runner-"));

    try {
      await writeBaseConfig(root, "code-review", "real");
      await writeWorkflow(root);
      await writeReviewPlannerAgent(root);

      const result = await runConfiguredWorkflow({
        invocation: {
          ...invocation,
          target: undefined,
          action: "opened"
        } as unknown as Invocation,
        configRoot: root,
        workflowsRoot: path.join(root, "workflows"),
        dependencies: {
          createRunIdentity: staticRunIdentity(githubRun),
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

  it("rejects malformed explicit targets", async () => {
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
          dependencies: {
            createRunIdentity: staticRunIdentity(githubRun),
            runBuiltInStep: vi.fn(),
            runAgentStep: vi.fn()
          }
        })
      ).rejects.toMatchObject({ code: "invalid_target" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
