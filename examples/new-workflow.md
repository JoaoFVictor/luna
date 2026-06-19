# Create A New Workflow

Workflows are YAML graphs. If the workflow uses existing Luna built-ins and
agents, no new TypeScript workflow entrypoint is required.

This recipe starts with a read-only workflow that operates on a GitHub PR and
local git repository context. Luna also includes a write-mode implementation
workflow for Jira tasks. A workflow for a different domain may need a new input
adapter, new built-in steps, or both.

## 1. Create The Workflow Directory

```text
workflows/my-workflow/
  workflow.yaml
  graph.yaml
  input.schema.json
  output.schema.json
```

## 2. Add `workflow.yaml`

```yaml
id: my-workflow
type: workflow
mode: git_managed_read_only
input_schema: input.schema.json
output_schema: output.schema.json
graph: graph.yaml
```

Rules:

- The directory name and `id` must match.
- `mode` supports `git_managed_read_only` and `git_managed_write`.
- Schema and graph paths must stay inside the workflow directory.

Use `git_managed_write` only for workflows that intentionally create a writable
worktree and run trusted local write agents.

## 3. Add `graph.yaml`

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

Graph rules:

- Node ids must be unique.
- `after` dependencies must point to existing nodes.
- Cycles are rejected.
- `type: built_in` uses a supported Luna built-in.
- `type: agent` references an agent under `agents/`.

## 4. Supported Built-Ins

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

Some built-ins are workflow-specific. If a workflow needs a new local
capability, add a built-in in TypeScript and then reference it from YAML.

## 5. Write-Mode Agent Loop

Write workflows can use an `agent_loop` node to run a trusted local implementer
and repair failed validation:

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

The referenced agent must declare `mode: trusted_host_local_write` in
`agent.yaml`. `trusted_host_local` runs on the host and can edit files in the
worktree. Use it only for agents and repositories you trust.

## 6. Workflow Input References

Node `input` values can reference workflow state:

- `$.invocation`: normalized input from adapter or JSON.
- `$.repository`: matched repository config.
- `$.run`: current run metadata.
- `$.workspace`: git worktree metadata.
- `$.config.implementation`: flattened runtime config from
  `config/implementation.yaml`.
- `$.steps.<node-id>`: output from a previous node.

Example:

```yaml
input:
  invocation: $.invocation
  plan: $.steps.review_plan
  findings: $.steps.validate_findings
```

References are whole-value references. Luna does not currently support nested
paths like `$.steps.review_plan.summary`.

## 7. Add Schemas

`input.schema.json` documents the workflow input contract.

`output.schema.json` documents the final workflow output contract.

For agent structured output, each agent still owns its own
`agents/<agent-id>/output.schema.json`.

## 8. Run The Workflow

From an adapter:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow my-workflow --from github-pr-url https://github.com/org/repo/pull/123
```

This works only if `my-workflow` accepts the GitHub PR invocation shape produced
by `github-pr-url`.

From a normalized invocation file:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow my-workflow --input path/to/invocation.json
```

For the bundled Jira implementation workflow, the adapter command is:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow implementation --from jira-task-url https://company.atlassian.net/browse/ABC-123
```

## 9. Test

```bash
npm test -- tests/core/workflow-definition.test.ts tests/core/configured-workflow-runner.test.ts
```
