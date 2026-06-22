import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunIdentityOptions } from "../../src/core/invocation/run-identity.js";
import type {
  Invocation,
  RunIdentity
} from "../../src/core/invocation/types.js";
import type { AcceptanceDecision } from "../../src/core/decisions/types.js";

export const invocation: Invocation = {
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

export const jiraInvocation: Invocation = {
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

export const githubRun: RunIdentity = {
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

export const jiraRun: RunIdentity = {
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

export const acceptedDecision: AcceptanceDecision = {
  status: "accepted",
  summary: "Accepted",
  blocking_reasons: [],
  recommended_action: "approve"
};

export function staticRunIdentity(run: RunIdentity) {
  return (_invocation: Invocation, options: RunIdentityOptions): RunIdentity => ({
    ...run,
    ...(options.runtimeRunId === undefined
      ? {}
      : { flue_run_id: options.runtimeRunId }),
    workflow_id: options.workflowId,
    attempt: options.attempt,
    started_at: options.date.toISOString()
  });
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}


export async function writeBaseConfig(
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

export async function writeWorkflow(
  root: string,
  extraMetadata: string[] = []
): Promise<void> {
  await writeFile(
    path.join(root, "workflows", "code-review", "workflow.yaml"),
    [
      "id: code-review",
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      "requires:",
      "  repository: true",
      ...extraMetadata,
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
      "    artifacts:",
      "      - path: preflight.json",
      "        source: $.steps.preflight",
      "        format: json",
      "  - id: repo_context",
      "    type: built_in",
      "    uses: collect_repo_context",
      "    artifacts:",
      "      - path: repo-context.json",
      "        source: $.steps.repo_context",
      "        format: json",
      "    after:",
      "      - preflight",
      "  - id: review_plan",
      "    type: agent",
      "    agent: review-planner",
      "    output_schema: review_plan",
      "    artifacts:",
      "      - path: review-plan.json",
      "        source: $.steps.review_plan",
      "        format: json",
      "    input:",
      "      repo_context: $.steps.repo_context",
      "    after:",
      "      - repo_context",
      ""
    ].join("\n")
  );
}


export async function writePreflightWorkflow(
  root: string,
  workflowId = "lock-options",
  execution: string[] = []
): Promise<void> {
  await mkdir(path.join(root, "workflows", workflowId), { recursive: true });
  await writeFile(
    path.join(root, "workflows", workflowId, "workflow.yaml"),
    [
      `id: ${workflowId}`,
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      ...execution,
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflows", workflowId, "graph.yaml"),
    [
      "nodes:",
      "  - id: preflight",
      "    type: built_in",
      "    uses: preflight",
      "    artifacts:",
      "      - path: preflight.json",
      "        source: $.steps.preflight",
      "        format: json",
      ""
    ].join("\n")
  );
}


export async function writeImplementationConfig(
  root: string,
  options: {
    commitEnabled?: boolean;
    pushEnabled?: boolean;
    changeRequestEnabled?: boolean;
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
      "  change_request:",
      `    enabled: ${options.changeRequestEnabled === true ? "true" : "false"}`,
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

export async function writeImplementationWorkflow(root: string): Promise<void> {
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
      "mode: trusted_local_write",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      "requires:",
      "  repository: true",
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
      "    artifacts:",
      "      - path: preflight.json",
      "        source: $.steps.preflight",
      "        format: json",
      "  - id: workspace",
      "    type: built_in",
      "    uses: prepare_implementation_worktree",
      "    artifacts:",
      "      - path: workspace.json",
      "        source: $.steps.workspace",
      "        format: json",
      "    after:",
      "      - preflight",
      "  - id: implementation",
      "    type: gated_agent_loop",
      "    agent: code-implementer",
      "    output_schema: implementation_result",
      "    input:",
      "      task_context: $.steps.workspace",
      "    sandbox:",
      "      type: trusted_host_local",
      "      cwd: $.workspace.path",
      "      env_allowlist: []",
      "    gates:",
      "      - id: validation",
      "        type: validation_commands",
      "        commands: $.config.implementation.validation.commands",
      "        max_output_bytes: $.config.implementation.validation.max_output_bytes",
      "      - id: acceptance",
      "        type: agent",
      "        agent: change-acceptance-reviewer",
      "        block_when:",
      "          expression: status != 'accepted'",
      "        feedback:",
      "          expression: \"{ 'status': status, 'blocking_reasons': blocking_reasons }\"",
      "    repair:",
      "      attempts: $.config.implementation.validation.repair_attempts",
      "    after:",
      "      - workspace",
      "  - id: implementation_validation",
      "    type: built_in",
      "    uses: record_implementation_validation",
      "    input:",
      "      implementation: $.steps.implementation",
      "    artifacts:",
      "      - path: implementation-validation.json",
      "        source: $.steps.implementation_validation.validation",
      "        format: json",
      "    after:",
      "      - implementation",
      "  - id: commit",
      "    type: built_in",
      "    uses: commit_changes",
      "    input:",
      "      validation: $.steps.implementation_validation.validation",
      "      acceptance: $.steps.implementation.result.acceptance",
      "      diff: $.steps.implementation.result.diff_summary",
      "      message: Implementation",
      "    artifacts:",
      "      - path: commit.json",
      "        source: $.steps.commit",
      "        format: json",
      "    after:",
      "      - implementation_validation",
      "  - id: push",
      "    type: built_in",
      "    uses: push_branch",
      "    artifacts:",
      "      - path: push.json",
      "        source: $.steps.push",
      "        format: json",
      "    after:",
      "      - commit",
      "  - id: change_request",
      "    type: built_in",
      "    uses: open_change_request",
      "    artifacts:",
      "      - path: change-request.json",
      "        source: $.steps.change_request",
      "        format: json",
      "    after:",
      "      - push",
      "  - id: final_report",
      "    type: built_in",
      "    uses: final_implementation_report",
      "    artifacts:",
      "      - path: final-report.json",
      "        source: $.steps.final_report.json",
      "        format: json",
      "      - path: final-report.md",
      "        source: $.steps.final_report.markdown",
      "        format: markdown",
      "    after:",
      "      - change_request",
      ""
    ].join("\n")
  );
}


export async function writeFullCodeReviewWorkflow(root: string): Promise<void> {
  await writeFile(
    path.join(root, "workflows", "code-review", "workflow.yaml"),
    [
      "id: code-review",
      "type: workflow",
      "mode: read_only",
      "input_schema: input.schema.json",
      "output_schema: output.schema.json",
      "graph: graph.yaml",
      "requires:",
      "  repository: true",
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
      "    artifacts:",
      "      - path: preflight.json",
      "        source: $.steps.preflight",
      "        format: json",
      "  - id: workspace",
      "    type: built_in",
      "    uses: prepare_worktree",
      "    artifacts:",
      "      - path: workspace.json",
      "        source: $.steps.workspace",
      "        format: json",
      "    after:",
      "      - preflight",
      "  - id: repo_context",
      "    type: built_in",
      "    uses: collect_repo_context",
      "    artifacts:",
      "      - path: repo-context.json",
      "        source: $.steps.repo_context",
      "        format: json",
      "    after:",
      "      - workspace",
      "  - id: review_plan",
      "    type: agent",
      "    agent: review-planner",
      "    output_schema: review_plan",
      "    artifacts:",
      "      - path: review-plan.json",
      "        source: $.steps.review_plan",
      "        format: json",
      "    input:",
      "      repo_context: $.steps.repo_context",
      "    after:",
      "      - repo_context",
      "  - id: code_review",
      "    type: agent",
      "    agent: change-reviewer",
      "    output_schema: code_review_findings",
      "    artifacts:",
      "      - path: raw-code-review-findings.json",
      "        source: $.steps.code_review",
      "        format: json",
      "    input:",
      "      review_plan: $.steps.review_plan",
      "    after:",
      "      - review_plan",
      "  - id: validate_findings",
      "    type: built_in",
      "    uses: validate_code_review_findings",
      "    artifacts:",
      "      - path: code-review-findings.json",
      "        source: $.steps.validate_findings",
      "        format: json",
      "    input:",
      "      repo_context: $.steps.repo_context",
      "      findings: $.steps.code_review",
      "    after:",
      "      - code_review",
      "  - id: acceptance",
      "    type: agent",
      "    agent: change-acceptance-reviewer",
      "    output_schema: acceptance_decision",
      "    artifacts:",
      "      - path: acceptance-review.json",
      "        source: $.steps.acceptance",
      "        format: json",
      "    input:",
      "      findings: $.steps.validate_findings",
      "    after:",
      "      - validate_findings",
      "  - id: final_report",
      "    type: built_in",
      "    uses: final_code_review_report",
      "    artifacts:",
      "      - path: final-report.json",
      "        source: $.steps.final_report.json",
      "        format: json",
      "      - path: final-report.md",
      "        source: $.steps.final_report.markdown",
      "        format: markdown",
      "    input:",
      "      findings: $.steps.validate_findings",
      "      acceptance: $.steps.acceptance",
      "    after:",
      "      - acceptance",
      ""
    ].join("\n")
  );
}


export async function writeReviewPlannerAgent(root: string): Promise<void> {
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

export async function writeAgent(root: string, id: string): Promise<void> {
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


export function artifactPath(
  root: string,
  workflowId: string,
  runId: string,
  name: string
): string {
  return path.join(root, "artifacts", workflowId, runId, name);
}

export async function readJson(
  root: string,
  workflowId: string,
  runId: string,
  name: string
): Promise<unknown> {
  return JSON.parse(
    await readFile(artifactPath(root, workflowId, runId, name), "utf8")
  ) as unknown;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
