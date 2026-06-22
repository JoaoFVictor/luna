# Configured Workflows

This guide is the practical extension map for Luna. It explains what can be
created with configuration and what still requires TypeScript.

Public extension paths:

- `agents/<id>/` for reusable Luna agent definitions.
- `workflows/<id>/` for YAML workflow graphs.
- `src/adapters/<id>/` for input adapters.
- `src/core/built-ins/` for deterministic YAML built-ins.
- `src/core/tools/` for Luna-native local tools.
- `src/core/agent-runtime/flue/` for the current Flue runtime adapter.

For step-by-step recipes, see:

- [Run a GitHub PR review](review-pr.md)
- [Implement a Jira task](implementation-jira-task.md)
- [Create a new agent](new-agent.md)
- [Create a new workflow](new-workflow.md)
- [Create a new input adapter](new-adapter.md)
- [Create a new built-in step](new-built-in.md)
- [Create a new local tool](new-tool.md)

Choose the guide by intent:

- If you only want to use Luna, start with `review-pr.md`.
- If you want Luna to implement a Jira task in a write worktree, start with
  `implementation-jira-task.md`.
- If you want a new role in an existing graph, start with `new-agent.md`.
- If you want a new orchestration shape, start with `new-workflow.md`.
- If you want Slack, API events, GitHub issues, or another input source, start
  with `new-adapter.md`.
- If you want a deterministic local workflow capability, start with
  `new-built-in.md`.
- If you want to expose deterministic local functions to an agent, start with
  `new-tool.md`.

## Runtime Model

Luna exposes one generic workflow entrypoint named `luna` through the current
Flue runtime adapter.

```text
adapter or JSON input -> invocation -> route -> workflow graph -> built-ins/agents/agent loops -> artifacts
```

The workflow id comes from one of these places:

1. The CLI target override:
   ```bash
   --target workflow:code-review
   ```
2. The normalized invocation's `target` field.
3. `config/routing.yaml`.

The common command shape is:

```bash
rtk env LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:<workflow-id> --from <adapter> <value>
```

The lower-level JSON path is useful for tests and automation:

```bash
rtk env LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:<workflow-id> --input path/to/invocation.json
```

The committed workflows consume Luna's normalized invocation shape. See
`examples/github-pr-opened.invocation.json` for a GitHub PR example. URL
adapters omit `target` unless the CLI override is used; otherwise routing can
come from the invocation `target` or `config/routing.yaml`. The
`jira-task-url` adapter builds a normalized Jira issue invocation by reading
Jira issue fields and matching the referenced GitHub repository.

Configured context is explicit in the workflow graph. A workflow runs
`collect_context`, lists the agents that should receive agent-owned context,
and passes `context: $.steps.context` to those agent or agent-loop nodes. Luna
then renders matching agent `context.files` before repository `context.files`
inside runtime instructions and leaves only `context_audit` in task input.

## Current Inventory

Input adapters:

- `github-pr-url`
- `jira-task-url`

Workflows:

- `code-review`
- `example-complete-agent`
- `implementation`

Agents:

- `example-complete-agent`
- `review-planner`
- `change-reviewer`
- `change-acceptance-reviewer`
- `implementation-planner`
- `code-implementer`

Built-in steps:

- `preflight`
- `prepare_worktree`
- `collect_context`
- `collect_repo_context`
- `validate_code_review_findings`
- `final_code_review_report`
- `prepare_implementation_worktree`
- `collect_task_context`
- `run_validation_commands`
- `record_implementation_validation`
- `collect_worktree_diff`
- `record_acceptance_decision`
- `commit_changes`
- `push_branch`
- `open_change_request`
- `final_implementation_report`

Local tools:

- `repository.status`
- `repository.diff-summary`

Project skills:

- `luna-project-map`
- `luna-create-agent`
- `luna-create-workflow`
- `luna-create-adapter`
- `luna-create-built-in`
- `luna-create-tool`
- `luna-review-change`
- `implementation-safe-git`

Agent configs reference skills by relative paths to `SKILL.md`, for example
`../../skills/luna-create-workflow/SKILL.md`.

Model profiles:

- `default`
- `deep`
- `fast`
- `balanced`

Model profiles live in `config/models.yaml`. Keep profile names capability
based, and put runtime transport there instead of on agents or workflows:

```yaml
model_profiles:
  default:
    model: ${DEFAULT_MODEL:-openai-codex/gpt-5.4-mini}
    reasoning_effort: medium
    transport: sse
```

`transport` is optional. The current Flue/Pi adapter supports `auto`, `sse`,
and `websocket`; `sse` is the local default for `openai-codex/...` profiles to
avoid abnormal WebSocket closures on long prompts.

## Adding An Agent

Create:

```text
agents/<agent-id>/
  agent.yaml
  instructions.md
  output.schema.json
```

Minimal `agent.yaml`:

```yaml
id: my-agent
description: Short responsibility statement.
model_profile: default
mode: read_only
instructions_file: instructions.md
output_schema: output.schema.json
```

Agents that write to a trusted local implementation worktree must explicitly
declare:

```yaml
mode: trusted_host_local_write
```

This pairs with an `agent_loop` node whose sandbox is `trusted_host_local`.
That mode can edit the configured worktree on the host. Treat it as a trusted
operator setting, not as an isolation boundary.

`instructions.md` should describe only that agent's role. Keep orchestration in
the workflow graph, not inside every agent prompt.

`output.schema.json` is the structured output contract. The current supported
subset covers objects, required properties, arrays, strings, numbers, integers,
booleans, string enums, `minLength`, and `minimum`.

Use capability-based model profiles:

```yaml
model_profile: default
```

Avoid role-based model profiles:

```yaml
model_profile: reviewer
```

The same agent can be reused by multiple workflows as long as its input contract
and instructions make sense in both places.

Configured workflows do not attach tools directly. The graph picks agents; each
agent declares its own skills and tools.

## Reusing Agents Across Workflows

Agents are meant to be reused when the role and input contract still make
sense. For example, `change-reviewer` can be used by the bundled
`code-review` workflow and by a future `release-risk-review` workflow if both
graphs pass it repository context and review instructions with the same shape:

```yaml
- id: release_risk_review
  type: agent
  agent: change-reviewer
  output_schema: code_review_findings
  artifacts:
    - path: release-risk-review.json
      source: $.steps.release_risk_review
      format: json
  input:
    invocation: $.invocation
    repo_context: $.steps.repo_context
    plan: $.steps.release_plan
  after:
    - repo_context
    - release_plan
```

Create a new agent when the responsibility, allowed capabilities, or output
schema changes. Reuse an existing agent when only the workflow context changes.

Subagents are agent capabilities, not graph nodes. They run as read-only Flue
profiles by default using the referenced agent's description, instructions,
model profile, and skills. Read-only subagents cannot declare local tools, MCP
servers, or nested subagents. Trusted write subagents require workflow-level
`subagent_policy.allow_write: true` plus a per-subagent tool allowlist on the
parent agent. Use graph nodes when the result must have its own artifact,
schema, workflow gate, MCP access, another delegation tree, or independent write
step. Use Flue subagents for lightweight internal delegation
inside a parent agent.

## MCP Capabilities

Agents can opt into configured MCP servers:

```yaml
mcp_servers:
  - github
```

MCP server policy lives in `config/mcp.yaml`. Secrets stay in environment
variables. `allowed_tools` uses original MCP tool names, such as
`get_pull_request`; Flue exposes them to the model as adapted names like
`mcp__github__get_pull_request`. Luna filters exposed MCP tools through that
allowlist and rejects servers that are not allowed for the agent mode.

Example `config/mcp.yaml` entry:

```yaml
mcp_servers:
  - id: github
    transport: streamable-http
    url_env: LUNA_MCP_GITHUB_URL
    headers:
      Authorization:
        env: LUNA_MCP_GITHUB_TOKEN
        prefix: "Bearer "
    allowed_tools:
      - get_pull_request
    allowed_agent_modes:
      - read_only
    timeout_ms: 30000
```

## Adding A Workflow

Create:

```text
workflows/<workflow-id>/
  workflow.yaml
  graph.yaml
  input.schema.json
  output.schema.json
```

Minimal `workflow.yaml`:

```yaml
id: my-workflow
type: workflow
mode: git_managed_read_only
input_schema: input.schema.json
output_schema: output.schema.json
graph: graph.yaml
```

Artifact directories are always resolved as:
`<app.artifacts.root>/<workflow-id>/<run-id>/`

Workflow YAML does not define a separate artifact namespace. The routed
`workflow_id` is the only namespace.

Every run writes:

- `run.json` for strict run identity.
- `events.jsonl` for append-only Luna runtime events.
- `observability-summary.json` for derived prompt usage, token/cost totals,
  failed-step counts, rejected-capability counts, and prompt usage gaps.

`events.jsonl` is mandatory and cannot be disabled. Optional exporters attach
beside it. Today the accepted optional exporter key is `runtime_log`;
OpenTelemetry, Braintrust, and Sentry are future exporter targets, not accepted
workflow config keys.

Workflow YAML can set optional observability exporters and the workflow-level
subagent write policy:

```yaml
observability:
  exporters:
    runtime_log:
      enabled: true
      required: false

subagent_policy:
  allow_write: false
```

Workflow YAML can set scheduler concurrency and per-workflow lock timeout:

```yaml
execution:
  max_concurrency: 4
  lock_timeout_ms: 120000
```

`max_concurrency > 1` remains supported. Luna schedules independent workflow
nodes in parallel according to graph dependencies, while run artifacts and
observability events stay scoped to the same run.

Agent and agent-loop nodes can set a retry policy for transient runtime
failures:

```yaml
retry:
  max_attempts: 3
  initial_delay_ms: 1000
  max_delay_ms: 10000
  backoff_multiplier: 2
  jitter: full
```

The default read-only policy retries transient transport, timeout, rate-limit,
and provider-availability failures. Trusted write-mode agent loops reject
`max_attempts > 1` to avoid replaying side effects after a dropped connection.
If Codex reports `WebSocket closed 1006`, set the affected model profile to
`transport: sse` instead of increasing write-mode retry.

`app.yaml` can set local lock storage defaults:

```yaml
locks:
  root: .luna/locks
  timeout_ms: 120000
  stale_after_ms: 600000
```

The write-mode implementation workflow uses:

```yaml
mode: git_managed_write
```

Minimal `graph.yaml`:

```yaml
nodes:
  - id: preflight
    type: built_in
    uses: preflight
    artifacts:
      - path: preflight.json
        source: $.steps.preflight
        format: json

  - id: workspace
    type: built_in
    uses: prepare_worktree
    artifacts:
      - path: workspace.json
        source: $.steps.workspace
        format: json
    after:
      - preflight

  - id: repo_context
    type: built_in
    uses: collect_repo_context
    artifacts:
      - path: repo-context.json
        source: $.steps.repo_context
        format: json
    after:
      - workspace

  - id: my_agent_step
    type: agent
    agent: my-agent
    output_schema: my_output
    artifacts:
      - path: my-agent-output.json
        source: $.steps.my_agent_step
        format: json
    input:
      invocation: $.invocation
      repo_context: $.steps.repo_context
    after:
      - repo_context
```

Graph validation catches duplicate node ids, unknown dependencies, and cycles.

## Node Types

Built-in node:

```yaml
- id: repo_context
  type: built_in
  uses: collect_repo_context
  artifacts:
    - path: repo-context.json
      source: $.steps.repo_context
      format: json
  after:
    - workspace
```

Agent node:

```yaml
- id: code_review
  type: agent
  agent: change-reviewer
  output_schema: code_review_findings
  artifacts:
    - path: code-review-findings.json
      source: $.steps.code_review
      format: json
  input:
    invocation: $.invocation
    repo_context: $.steps.repo_context
  after:
    - repo_context
```

Agent loop node:

```yaml
- id: implementation
  type: agent_loop
  agent: code-implementer
  output_schema: implementation_result
  artifacts:
    - path: implementation-attempts.json
      source: $.steps.implementation.attempts
      format: json
    - path: validation.json
      source: $.steps.implementation.validation
      format: json
    - path: implementation-result.json
      source: $.steps.implementation.result
      format: json
  sandbox:
    type: trusted_host_local
    cwd: $.workspace.path
    env_allowlist: []
  validation:
    commands: $.config.implementation.validation.commands
    max_output_bytes: $.config.implementation.validation.max_output_bytes
  repair:
    attempts: $.config.implementation.validation.repair_attempts
```

`artifacts` maps explicit state sources to files in the run artifact directory:

```yaml
artifacts:
  - path: final-report.json
    source: $.steps.final_report.json
    format: json
    required: true
  - path: final-report.md
    source: $.steps.final_report.markdown
    format: markdown
    required: true
```

## Workflow Input References

Node `input` values can reference workflow state:

- `$.invocation`: normalized input from adapter or JSON.
- `$.repository`: matched repository config.
- `$.run`: current run metadata.
- `$.workspace`: git worktree metadata.
- `$.config.implementation`: flattened implementation runtime config from
  `config/implementation.yaml`.
- `$.steps.<node-id>`: output from a previous node.

Example:

```yaml
input:
  invocation: $.invocation
  plan: $.steps.review_plan
  findings: $.steps.validate_findings
```

References support whole values and nested paths, such as
`$.steps.review_plan.summary`.

## Adding An Input Adapter

Adapters exist so callers do not need to hand-write invocation JSON.

The current adapter command is:

```bash
rtk env LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:code-review --from github-pr-url https://github.com/org/repo/pull/123
```

The Jira implementation adapter command is:

```bash
rtk env LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:implementation --from jira-task-url https://company.atlassian.net/browse/ABC-123
```

To add a new adapter:

1. Create a module under `src/adapters/<adapter-id>/adapter.ts`, for example
   `src/adapters/slack-message-url/adapter.ts`.
2. Export an `InputAdapter` object with `id`, `description`, and
   `load(input, context)`.
3. Validate external input early.
4. Fetch source metadata using the source's normal tool or API.
5. Return a normalized invocation parsed with Luna's `InvocationSchema`.
6. Register the adapter once in `src/adapters/registry.ts`.
7. Add unit tests for the adapter.
8. Add CLI tests proving `--from <adapter>` dispatches to it.
9. Add docs to `README.md` and this file.

Keep the CLI shape generic:

```bash
run --target workflow:<workflow-id> --from <adapter> <value>
```

Do not add one-off commands such as:

```bash
review-pr <url>
```

## Adapter Responsibilities

An adapter should:

- Convert source-specific input into Luna's normalized invocation.
- Return `version`, `source`, `event`, optional `action`, and normalized
  `repository`, `subject`, `references`, and `payload` data as applicable.
- Omit `target` for URL adapters unless the CLI override is used.
- Preserve source metadata that agents may need.
- Return clear errors for invalid input and missing source auth.
- Avoid LLM routing decisions.

An adapter should not:

- Run the workflow directly.
- Create git worktrees.
- Write final artifacts.
- Hide which workflow is being called.

## YAML vs TypeScript

Use YAML/config for:

- New agents under `agents/<id>/`.
- New workflow graphs under `workflows/<id>/` using existing built-ins.
- New model profiles.
- New MCP server policy in `config/mcp.yaml`.
- New local repository entries.
- New routing rules.
- Jira instance mappings in `config/jira.yaml`.
- Implementation validation and publishing gates in
  `config/implementation.yaml`.

Use TypeScript for:

- New input adapters under `src/adapters/<id>/`.
- New deterministic workflow built-ins under `src/core/built-ins/`.
- New Luna-native local tools under `src/core/tools/`.
- New workspace or repository behavior.
- New artifact behavior.
- JSON Schema features outside Luna's supported subset.

Built-ins are registered in `src/core/built-ins/catalog.ts`. The catalog is the
source of truth for both YAML validation and runtime execution; do not add a
second handwritten list of built-in names. Local tools are registered in
`src/core/tools/catalog.ts` and materialized for Flue under
`src/core/agent-runtime/flue/`.

## Testing Checklist

For a new agent:

```bash
rtk npm test -- tests/core/agent-definition.test.ts
```

For a new workflow:

```bash
rtk npm test -- tests/core/workflow-definition.test.ts tests/core/configured-workflow-runner.test.ts
```

For a new adapter:

```bash
rtk npm test -- tests/core/cli.test.ts tests/adapters/github-pr-url-adapter.test.ts
```

Before finishing a branch:

```bash
rtk npm test
rtk npm run typecheck
rtk npm run typecheck:unused-src
rtk npm run lint:unused
rtk npm run build
rtk npm run flue:build
```

## Write-Mode Configuration

The `implementation` workflow is a `git_managed_write` workflow. It creates a
writable worktree, runs `code-implementer` through `trusted_host_local`, validates
the result, reviews it, and then optionally commits, pushes, and opens a change
request. The first supported change request provider is GitHub, which opens a
draft PR.

`config/implementation.yaml` controls:

- `sandbox.type: trusted_host_local` for local host execution.
- `validation.commands` for structured process entries such as
  `cmd: "npm", args: ["test"]` and
  `cmd: "npm", args: ["run", "typecheck"]`. Luna passes `cmd` and `args`
  directly to the validation runner without a shell; keep `rtk` for commands
  humans run in this repository, not for validation config entries.
- `validation.repair_attempts` for agent repair loops after failed validation.
- `commit.enabled`, `push.enabled`, and `change_request.enabled` for publishing.

Publishing gates are ordered. Push requires commit, and change request creation
requires push. If commit is disabled, validation fails, acceptance rejects the
change, or a publishing gate is skipped or fails, Luna preserves the write
worktree for inspection.

Write-mode repository entries should include `expected_remote_urls`:

```yaml
repositories:
  - id: repo
    provider: github
    owner: org
    name: repo
    path: /path/to/local/repo
    remote: origin
    expected_remote_urls:
      - git@github.com:org/repo.git
    context:
      files:
        - AGENTS.md
        - README.md
```

When workflows include `collect_context`, Luna reads configured repository
context files from the prepared workspace and writes `context-intake.json` with
read, missing, and skipped files. Agent and agent-loop nodes that receive
`context: $.steps.context` get those files as runtime instructions, with raw
contents removed from task JSON.

The Jira adapter uses `config/jira.yaml` to map a Jira instance and repository
field:

```yaml
instances:
  - id: company
    base_url: https://company.atlassian.net
    repository_field:
      field_id: customfield_12345
      format: github_full_name
```

Jira secrets live in project-root `luna.auth.json`, keyed by the same instance
id:

```json
{
  "providers": {
    "jira": {
      "company": {
        "base_url": "https://company.atlassian.net",
        "auth_type": "basic_api_token",
        "email": "user@company.com",
        "api_token": "secret-token"
      }
    }
  }
}
```

## Real Review Checklist

1. Authenticate Pi:
   ```bash
   rtk npx @earendil-works/pi-ai login openai-codex
   ```
2. Authenticate GitHub:
   ```bash
   rtk gh auth status
   ```
3. Clone the target repo locally.
4. Add the repo to `config/repositories.yaml`.
5. Run:
   ```bash
   rtk env LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:code-review --from github-pr-url https://github.com/org/repo/pull/123
   ```
6. Open `.runs/code-review/<run-id>/final-report.md`.
