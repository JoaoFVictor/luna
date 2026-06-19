# Configured Workflows

This guide is the practical extension map for Luna. It explains what can be
created with configuration and what still requires TypeScript.

For step-by-step recipes, see:

- [Run a GitHub PR review](review-pr.md)
- [Implement a Jira task](implementation-jira-task.md)
- [Create a new agent](new-agent.md)
- [Create a new workflow](new-workflow.md)
- [Create a new input adapter](new-adapter.md)

Choose the guide by intent:

- If you only want to use Luna, start with `review-pr.md`.
- If you want Luna to implement a Jira task in a write worktree, start with
  `implementation-jira-task.md`.
- If you want a new role in an existing graph, start with `new-agent.md`.
- If you want a new orchestration shape, start with `new-workflow.md`.
- If you want Slack, API events, GitHub issues, or another input source, start
  with `new-adapter.md`.

## Runtime Model

Luna exposes one generic Flue workflow entrypoint named `luna`.

```text
adapter or JSON input -> invocation -> route -> workflow graph -> agents/built-ins -> artifacts
```

The workflow id comes from one of these places:

1. The CLI flag:
   ```bash
   --workflow code-review
   ```
2. The normalized invocation's `workflow` field.
3. `config/routing.yaml`.

The common command shape is:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow <workflow-id> --from <adapter> <value>
```

The lower-level JSON path is useful for tests and automation:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow <workflow-id> --input path/to/invocation.json
```

The committed workflows currently use GitHub PR and Jira task invocation
shapes. See `examples/github-pr-opened.invocation.json` for a GitHub PR
example. The `jira-task-url` adapter builds a `jira_task` invocation by reading
Jira issue fields and matching the referenced GitHub repository.

## Current Inventory

Input adapters:

- `github-pr-url`
- `jira-task-url`

Workflows:

- `code-review`
- `implementation`

Agents:

- `review-planner`
- `code-reviewer`
- `acceptance-reviewer`
- `implementation-planner`
- `code-implementer`
- `implementation-reviewer`
- `implementation-acceptance-reviewer`

Built-in steps:

- `preflight`
- `prepare_worktree`
- `collect_repo_context`
- `validate_code_review_findings`
- `final_code_review_report`
- `prepare_implementation_worktree`
- `collect_task_context`
- `collect_worktree_diff`
- `commit_changes`
- `push_branch`
- `open_pull_request`
- `final_implementation_report`

Model profiles:

- `default`
- `deep`
- `fast`
- `balanced`

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
artifacts:
  root_namespace: my-workflow
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
    artifact: preflight.json

  - id: workspace
    type: built_in
    uses: prepare_worktree
    artifact: workspace.json
    after:
      - preflight

  - id: repo_context
    type: built_in
    uses: collect_repo_context
    artifact: repo-context.json
    after:
      - workspace

  - id: my_agent_step
    type: agent
    agent: my-agent
    output_schema: my_output
    artifact: my-agent-output.json
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
  artifact: repo-context.json
  after:
    - workspace
```

Agent node:

```yaml
- id: code_review
  type: agent
  agent: code-reviewer
  output_schema: code_review_findings
  artifact: code-review-findings.json
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
  artifact:
    attempts: implementation-attempts.json
    validation: validation.json
    result: implementation-result.json
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

`artifact` can be a string or, for built-ins that write multiple files, a map:

```yaml
artifact:
  json: final-report.json
  markdown: final-report.md
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
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow code-review --from github-pr-url https://github.com/org/repo/pull/123
```

The Jira implementation adapter command is:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow implementation --from jira-task-url https://company.atlassian.net/browse/ABC-123
```

To add a new adapter:

1. Create a module under `src/core/`, for example
   `src/core/slack-message-adapter.ts`.
2. Export a function that receives the external value and returns a normalized
   invocation.
3. Validate external input early.
4. Fetch source metadata using the source's normal tool or API.
5. Parse the result with Luna's `InvocationSchema` or return data that will pass
   it in the CLI.
6. Register the adapter name in `src/core/flue-cli.ts`.
7. Add unit tests for the adapter.
8. Add CLI tests proving `--from <adapter>` dispatches to it.
9. Add docs to `README.md` and this file.

Keep the CLI shape generic:

```bash
run --workflow <workflow-id> --from <adapter> <value>
```

Do not add one-off commands such as:

```bash
review-pr <url>
```

## Adapter Responsibilities

An adapter should:

- Convert source-specific input into Luna's normalized invocation.
- Attach `workflow` only when the source has an explicit deterministic mapping.
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

- New agents.
- New workflow graphs using existing built-ins.
- New model profiles.
- New local repository entries.
- New routing rules.
- Jira instance mappings in `config/jira.yaml`.
- Implementation validation and publishing gates in
  `config/implementation.yaml`.

Use TypeScript for:

- New input adapters.
- New built-in steps.
- New workspace or repository behavior.
- New artifact behavior.
- JSON Schema features outside Luna's supported subset.

## Testing Checklist

For a new agent:

```bash
npm test -- tests/core/agent-definition.test.ts
```

For a new workflow:

```bash
npm test -- tests/core/workflow-definition.test.ts tests/core/configured-workflow-runner.test.ts
```

For a new adapter:

```bash
npm test -- tests/core/cli.test.ts tests/core/github-pr-adapter.test.ts
```

Before finishing a branch:

```bash
npm test
npm run typecheck
npm run build
npm run flue:build
```

## Write-Mode Configuration

The `implementation` workflow is a `git_managed_write` workflow. It creates a
writable worktree, runs `code-implementer` through `trusted_host_local`, validates
the result, reviews it, and then optionally commits, pushes, and opens a draft
GitHub PR.

`config/implementation.yaml` controls:

- `sandbox.type: trusted_host_local` for local host execution.
- `validation.commands` for commands such as `npm test` and
  `npm run typecheck`.
- `validation.repair_attempts` for agent repair loops after failed validation.
- `commit.enabled`, `push.enabled`, and `pull_request.enabled` for publishing.

Publishing gates are ordered. Push requires commit, and draft PR creation
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
```

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
   npx @earendil-works/pi-ai login openai-codex
   ```
2. Authenticate GitHub:
   ```bash
   gh auth status
   ```
3. Clone the target repo locally.
4. Add the repo to `config/repositories.yaml`.
5. Run:
   ```bash
   LUNA_CONFIG_ROOT=config npm run dev -- run --workflow code-review --from github-pr-url https://github.com/org/repo/pull/123
   ```
6. Open `.runs/code-review/<run-id>/final-report.md`.
