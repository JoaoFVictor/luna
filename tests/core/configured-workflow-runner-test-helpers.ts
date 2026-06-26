import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunIdentityOptions } from "../../src/core/invocation/run-identity.js";
import type {
  Invocation
} from "../../src/core/router/invocation.js";
import type { RunIdentity } from "../../src/core/invocation/types.js";
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
  await writeWorkflowSchemas(root, workflowId);

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
          "type: router",
          "version: \"2026-06\"",
          "rules:",
          "  - id: explicit_target",
          "    when:",
          "      expression: \"$exists($.invocation.target)\"",
          "    target: $.invocation.target",
          "  - id: github_pr_code_review",
          "    when:",
          `      expression: "$.invocation.source = 'github' and $.invocation.event = 'pull_request' and $.invocation.action in ['opened', 'synchronize', 'ready_for_review']"`,
          `    target: workflow:${workflowId}`,
          ""
        ].join("\n")
      : [
          "type: router",
          "version: \"2026-06\"",
          "rules:",
          "  - id: github_pr_code_review",
          "    when:",
          "      expression: \"true\"",
          `    target: workflow:${workflowId}`,
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

export async function writeWorkflowSchemas(
  root: string,
  workflowId: string
): Promise<void> {
  const workflowRoot = path.join(root, "workflows", workflowId);
  await mkdir(workflowRoot, { recursive: true });
  const schema = JSON.stringify({ type: "object", additionalProperties: true });
  await writeFile(path.join(workflowRoot, "input.schema.json"), schema);
  await writeFile(path.join(workflowRoot, "output.schema.json"), schema);
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
      "capabilities:",
      "  - runtime",
      "  - agents",
      "  - artifacts",
      "requires:",
      "  repository: true",
      ...extraMetadata,
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
      "  - id: repo_context",
      "    type: built_in",
      "    uses: runtime.collect_repo_context",
      "    artifacts:",
      "      - path: repo-context.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.repo_context\"",
      "        format: json",
      "    after:",
      "      - preflight",
      "  - id: review_plan",
      "    type: agent",
      "    agent: review-planner",
      "    output_schema: output.schema.json",
      "    artifacts:",
      "      - path: review-plan.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.review_plan\"",
      "        format: json",
      "    input:",
      "      repo_context:",
      "        expression: \"$.steps.repo_context\"",
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
      ...execution,
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
      "  - change-request",
      "requires:",
      "  repository: true",
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
      "    input:",
      "      task_context:",
      "        expression: \"$.steps.workspace\"",
      "    gates:",
      "      - id: validation",
      "        type: quality-gates.validation_commands",
      "        input:",
      "          commands:",
      "            expression: \"$.config.implementation.validation.commands\"",
      "          max_output_bytes:",
      "            expression: \"$.config.implementation.validation.max_output_bytes\"",
      "      - id: acceptance",
      "        type: quality-gates.agent_review",
      "        input:",
      "          review_agent: change-acceptance-reviewer",
      "          subject:",
      "            expression: \"$.gate.output\"",
      "        block_when:",
      "          expression: \"$.gate.decision = 'fail'\"",
      "        feedback:",
      "          expression: \"$.gate.feedback\"",
      "    repair:",
      "      attempts:",
      "        expression: \"$.config.implementation.validation.repair_attempts\"",
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
      "          expression: \"$.steps.implementation_validation.validation\"",
      "        format: json",
      "    after:",
      "      - implementation",
      "  - id: commit",
      "    type: built_in",
      "    uses: runtime.commit_changes",
      "    input:",
      "      validation:",
      "        expression: \"$.steps.implementation_validation.validation\"",
      "      acceptance:",
      "        expression: \"$.steps.implementation.result.acceptance\"",
      "      diff:",
      "        expression: \"$.steps.implementation.result.diff_summary\"",
      "      message: Implementation",
      "    artifacts:",
      "      - path: commit.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.commit\"",
      "        format: json",
      "    after:",
      "      - implementation_validation",
      "  - id: push",
      "    type: built_in",
      "    uses: runtime.push_branch",
      "    artifacts:",
      "      - path: push.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.push\"",
      "        format: json",
      "    after:",
      "      - commit",
      "  - id: change_request",
      "    type: built_in",
      "    uses: change-request.create",
      "    policies:",
      "      - uses: change-request.create_side_effect",
      "        config:",
      "          operation_id: change-request.create",
      "    input:",
      "      enabled:",
      "        expression: \"$.config.implementation.change_request.enabled\"",
      "      provider_id:",
      "        expression: \"$.config.implementation.change_request.provider\"",
      "      repository_path:",
      "        expression: \"$.steps.workspace.path\"",
      "      title: Implementation",
      "      source:",
      "        expression: \"$.steps.push\"",
      "      target_branch:",
      "        expression: \"$.config.implementation.change_request.base_ref\"",
      "      draft:",
      "        expression: \"$.config.implementation.change_request.draft\"",
      "    artifacts:",
      "      - path: change-request.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.change_request\"",
      "        format: json",
      "    after:",
      "      - push",
      "  - id: final_report",
      "    type: built_in",
      "    uses: runtime.final_implementation_report",
      "    artifacts:",
      "      - path: final-report.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.final_report.json\"",
      "        format: json",
      "      - path: final-report.md",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.final_report.markdown\"",
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
      "capabilities:",
      "  - runtime",
      "  - agents",
      "  - artifacts",
      "requires:",
      "  repository: true",
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
      "    uses: runtime.prepare_worktree",
      "    artifacts:",
      "      - path: workspace.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.workspace\"",
      "        format: json",
      "    after:",
      "      - preflight",
      "  - id: repo_context",
      "    type: built_in",
      "    uses: runtime.collect_repo_context",
      "    artifacts:",
      "      - path: repo-context.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.repo_context\"",
      "        format: json",
      "    after:",
      "      - workspace",
      "  - id: review_plan",
      "    type: agent",
      "    agent: review-planner",
      "    output_schema: output.schema.json",
      "    artifacts:",
      "      - path: review-plan.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.review_plan\"",
      "        format: json",
      "    input:",
      "      repo_context:",
      "        expression: \"$.steps.repo_context\"",
      "    after:",
      "      - repo_context",
      "  - id: code_review",
      "    type: agent",
      "    agent: change-reviewer",
      "    output_schema: output.schema.json",
      "    artifacts:",
      "      - path: raw-code-review-findings.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.code_review\"",
      "        format: json",
      "    input:",
      "      review_plan:",
      "        expression: \"$.steps.review_plan\"",
      "    after:",
      "      - review_plan",
      "  - id: validate_findings",
      "    type: built_in",
      "    uses: runtime.validate_code_review_findings",
      "    artifacts:",
      "      - path: code-review-findings.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.validate_findings\"",
      "        format: json",
      "    input:",
      "      repo_context:",
      "        expression: \"$.steps.repo_context\"",
      "      findings:",
      "        expression: \"$.steps.code_review\"",
      "    after:",
      "      - code_review",
      "  - id: acceptance",
      "    type: agent",
      "    agent: change-acceptance-reviewer",
      "    output_schema: output.schema.json",
      "    artifacts:",
      "      - path: acceptance-review.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.acceptance\"",
      "        format: json",
      "    input:",
      "      findings:",
      "        expression: \"$.steps.validate_findings\"",
      "    after:",
      "      - validate_findings",
      "  - id: final_report",
      "    type: built_in",
      "    uses: runtime.final_code_review_report",
      "    artifacts:",
      "      - path: final-report.json",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.final_report.json\"",
      "        format: json",
      "      - path: final-report.md",
      "        publisher: artifacts.manifest_publisher",
      "        source:",
      "          expression: \"$.steps.final_report.markdown\"",
      "        format: markdown",
      "    input:",
      "      findings:",
      "        expression: \"$.steps.validate_findings\"",
      "      acceptance:",
      "        expression: \"$.steps.acceptance\"",
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
