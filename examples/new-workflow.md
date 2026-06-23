# Create A New Workflow

Workflows are YAML graphs. If the workflow uses existing Luna built-ins and
agents, no new TypeScript workflow entrypoint is required.

Workflow definitions live under `workflows/<id>/`. Luna keeps one generic
TypeScript workflow entrypoint at `src/workflows/luna.ts`.

For the smallest runnable read-only reference, see
`workflows/example-minimal-agent/`.

```sh
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:example-minimal-agent --from github-pr-url https://github.com/org/repo/pull/123
```

For a runnable write-mode reference that uses the full example agent, see
`workflows/example-complete-agent/`.

This recipe starts with a read-only workflow that operates on a GitHub PR and
local git repository context. Luna also includes a write-mode implementation
workflow for external tasks such as Jira and Plane issues. A workflow for a
different domain may need a new input adapter, new built-in steps, or both.

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
mode: read_only
input_schema: input.schema.json
output_schema: output.schema.json
graph: graph.yaml
execution:
  max_concurrency: 2
  lock_timeout_ms: 120000
```

Rules:

- The directory name and `id` must match.
- `mode` supports `read_only` and `trusted_local_write`.
- Schema and graph paths must stay inside the workflow directory.

Artifact directories are always resolved as:
`<app.artifacts.root>/<workflow-id>/<run-id>/`

Workflow YAML does not define a separate artifact namespace. The routed
`workflow_id` is the only namespace.

`execution.max_concurrency` controls how many safe ready nodes the scheduler
may run at once. Repository-sensitive built-ins are still serialized by local
locks. Agent and `gated_agent_loop` nodes must not depend on shared mutable
local state; use workflow dependencies, artifacts, and repository locks to make
parallel runs safe.

Use `trusted_local_write` only for workflows that intentionally create a writable
worktree and run trusted local write agents.

## 3. Add `graph.yaml`

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

  - id: context
    type: built_in
    uses: collect_context
    artifacts:
      - path: context-intake.json
        source: $.steps.context
        format: json
    input:
      agents:
        - my-agent
    after:
      - workspace

  - id: my_agent_step
    type: agent
    agent: my-agent
    output_schema: my_output
    retry:
      max_attempts: 3
      initial_delay_ms: 1000
      max_delay_ms: 10000
      backoff_multiplier: 2
      jitter: full
    artifacts:
      - path: my-agent-output.json
        source: $.steps.my_agent_step
        format: json
    input:
      invocation: $.invocation
      repo_context: $.steps.repo_context
      context: $.steps.context
    after:
      - repo_context
      - context
```

`collect_context` reads configured repository context from
`config/repositories.yaml` and configured agent context from each listed
`agent.yaml`. Passing `context: $.steps.context` to an `agent` or `gated_agent_loop`
does not make the raw file contents ordinary task data. Luna renders them into
runtime instructions in this order: Luna runtime instructions, the agent's
`instructions.md`, matching agent context, repository context, then normal
workflow input. The task input receives `context_audit` with read, missing, and
skipped file metadata.

Graph rules:

- Node ids must be unique.
- `after` dependencies must point to existing nodes.
- Cycles are rejected.
- `type: built_in` uses a supported Luna built-in.
- `type: agent` references an agent under `agents/`.
- Read-only `agent` nodes retry transient runtime failures by default.
- `gated_agent_loop` write-mode nodes reject `max_attempts > 1` to avoid replaying
  local writes after a dropped connection.

## 4. Supported Built-Ins

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

Some built-ins are workflow-specific. If a workflow needs a new local
capability, add a built-in in TypeScript and then reference it from YAML.
See [Create a new built-in step](new-built-in.md) for the registry, metadata,
and test pattern.

## 5. Gated Agent Loop

Write workflows can use a `gated_agent_loop` node to run a trusted local implementer
and repair failed gates:

```yaml
- id: implementation
  type: gated_agent_loop
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
  gates:
    - id: validation
      type: validation_commands
      commands: $.config.implementation.validation.commands
      max_output_bytes: $.config.implementation.validation.max_output_bytes
    - id: review
      type: agent
      agent: change-reviewer
      block_when:
        expression: "$count(findings) > 0"
      feedback:
        expression: "findings"
      input:
        invocation: $.invocation
        context: $.steps.context
    - id: acceptance
      type: agent
      agent: change-acceptance-reviewer
      block_when:
        expression: "status != 'accepted'"
      feedback:
        expression: "{ 'status': status, 'blocking_reasons': blocking_reasons }"
      input:
        invocation: $.invocation
        context: $.steps.context
  repair:
    attempts: $.config.implementation.validation.repair_attempts
```

The referenced agent must declare `mode: trusted_local_write` in
`agent.yaml`. `trusted_host_local` runs on the host and can edit files in the
worktree. Use it only for agents and repositories you trust.

Configure gates in `workflows/<id>/graph.yaml` under the `gated_agent_loop`
node's `gates:` list. Supported gates:

- `validation_commands`: runs deterministic commands and blocks on failed
  validation.
- workflow `agent`: runs a read-only agent as a gate. Configure `block_when` on
  the workflow gate entry. The referenced `agents/<id>/agent.yaml` owns the
  agent instructions and output schema.

Workflow `agent` gate expressions:

- `block_when.expression`: JSONata evaluated against the gate agent output. It
  must return a boolean. `true` blocks; `false` passes.
- `feedback.expression`: optional JSONata evaluated against the gate agent
  output only when the gate blocks. Its result is serialized as repair
  feedback.

When any gate fails, Luna sends previous validation, gate feedback, and diff
summary back to the trusted write agent for a repair attempt. In write
workflows, use deterministic built-ins after agent or `gated_agent_loop` nodes
to record lifecycle gates used by workspace preserve/cleanup decisions.

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
  context: $.steps.context
  plan: $.steps.review_plan
  findings: $.steps.validate_findings
```

References support whole values and nested paths, such as
`$.steps.review_plan.summary`.

## 7. Add Schemas

`input.schema.json` documents the workflow input contract.

`output.schema.json` documents the final workflow output contract.

For agent structured output, each agent still owns its own
`agents/<agent-id>/output.schema.json`.

## 8. Run The Workflow

From an adapter:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:my-workflow --from github-pr-url https://github.com/org/repo/pull/123
```

This works only if `my-workflow` accepts the normalized GitHub PR invocation
produced by `github-pr-url`.

From a normalized invocation file:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:my-workflow --input path/to/invocation.json
```

For the bundled implementation workflow, use a task adapter such as Jira:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:implementation --from jira-task-url https://company.atlassian.net/browse/ABC-123
```

or Plane:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:implementation --from plane-task-url https://app.plane.so/company/browse/PROJ-42/
```

## 9. Test

```bash
npm test -- tests/core/workflow-definition.test.ts tests/core/configured-workflow-runner.test.ts
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```
