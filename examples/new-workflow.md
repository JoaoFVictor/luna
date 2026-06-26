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
capabilities:
  - runtime
  - repository-workspace
  - context
  - agents
  - artifacts
requires:
  repository: true
execution:
  max_concurrency: 2
  lock_timeout_ms: 120000
nodes:
  - id: preflight
    type: built_in
    uses: runtime.preflight
    artifacts:
      - path: preflight.json
        publisher: artifacts.manifest_publisher
        source:
          expression: "$.steps.preflight"
        format: json

  - id: workspace
    type: built_in
    uses: repository-workspace.capture
    artifacts:
      - path: workspace.json
        publisher: artifacts.manifest_publisher
        source:
          expression: "$.steps.workspace"
        format: json
    after:
      - preflight

  - id: repo_context
    type: built_in
    uses: runtime.collect_repo_context
    artifacts:
      - path: repo-context.json
        publisher: artifacts.manifest_publisher
        source:
          expression: "$.steps.repo_context"
        format: json
    after:
      - workspace

  - id: context
    type: built_in
    uses: context.collect_context
    artifacts:
      - path: context-intake.json
        publisher: artifacts.manifest_publisher
        source:
          expression: "$.steps.context"
        format: json
    input:
      agents:
        - my-agent
    after:
      - workspace

  - id: my_agent_step
    type: agent
    agent: my-agent
    output_schema: my-agent-output.schema.json
    retry:
      max_attempts: 3
      initial_delay_ms: 1000
      max_delay_ms: 10000
      backoff_multiplier: 2
      jitter: full
    artifacts:
      - path: my-agent-output.json
        publisher: artifacts.manifest_publisher
        source:
          expression: "$.steps.my_agent_step"
        format: json
    input:
      invocation:
        expression: "$.invocation"
      repo_context:
        expression: "$.steps.repo_context"
      context:
        expression: "$.steps.context"
    after:
      - repo_context
      - context
```

Rules:

- The directory name and `id` must match.
- `mode` supports `read_only` and `trusted_local_write`.
- Schema paths must stay inside the workflow directory.

Artifact directories are always resolved as:
`<app.artifacts.root>/<workflow-id>/<run-id>/`

Workflow YAML does not define a separate artifact namespace. The routed
`workflow_id` is the only namespace.

`execution.max_concurrency` controls how many safe ready nodes the scheduler
may run at once. Repository-sensitive built-ins are still serialized by local
locks. Agent and pattern nodes must not depend on shared mutable local state;
use workflow dependencies, artifacts, and repository locks to make parallel
runs safe.

Use `trusted_local_write` only for workflows that intentionally create a
writable worktree and run trusted local write agents.

`collect_context` reads configured repository context from
`config/repositories.yaml` and configured agent context from each listed
`agent.yaml`. Passing `context: { expression: "$.steps.context" }` to an agent
or pattern worker does not make the raw file contents ordinary task data. Luna
renders them into runtime instructions in this order: Luna runtime instructions,
the agent's `instructions.md`, matching agent context, repository context, then
normal workflow input. The task input receives `context_audit` with read,
missing, and skipped file metadata.

Graph rules:

- Node ids must be unique.
- `after` dependencies must point to existing nodes.
- Cycles are rejected.
- `type: built_in` uses a supported Luna built-in.
- `type: agent` references an agent under `agents/`.
- `type: pattern` references a supported workflow pattern.
- Read-only `agent` nodes retry transient runtime failures by default.
- Trusted write gated agent loops use `repair.attempts` for validation repair
  and reject retry semantics that would replay local file writes.

## 4. Supported Built-Ins

- `change-request.create`
- `context.collect_context`
- `git.commit`
- `local-exec.command.read`
- `local-exec.command.write`
- `reports.final_report`
- `repository-workspace.capture`
- `runtime.collect_repo_context`
- `runtime.collect_task_context`
- `runtime.collect_worktree_diff`
- `runtime.commit_changes`
- `runtime.final_code_review_report`
- `runtime.final_implementation_report`
- `runtime.open_change_request`
- `runtime.preflight`
- `runtime.prepare_implementation_worktree`
- `runtime.prepare_worktree`
- `runtime.push_branch`
- `runtime.record_implementation_validation`
- `runtime.validate_code_review_findings`

Some built-ins are workflow-specific. If a workflow needs a new local
capability, add a built-in in TypeScript and then reference it from YAML.
See [Create a new built-in step](new-built-in.md) for the registry, metadata,
and test pattern.

## 5. Gated Agent Loop

Write workflows can use a `quality-gates.gated_agent_loop` pattern node to run
a trusted local implementer and repair failed gates:

```yaml
- id: implementation
  type: pattern
  uses: quality-gates.gated_agent_loop
  worker: code-implementer
  artifacts:
    - path: implementation-attempts.json
      publisher: artifacts.manifest_publisher
      source:
        expression: "$.steps.implementation.attempts"
      format: json
    - path: validation.json
      publisher: artifacts.manifest_publisher
      source:
        expression: "$.steps.implementation.validation"
      format: json
    - path: implementation-result.json
      publisher: artifacts.manifest_publisher
      source:
        expression: "$.steps.implementation.result"
      format: json
  gates:
    - id: validation
      type: quality-gates.validation_commands
      input:
        commands:
          expression: "$.config.implementation.validation.commands"
        max_output_bytes:
          expression: "$.config.implementation.validation.max_output_bytes"
    - id: review
      type: quality-gates.agent_review
      input:
        review_agent: change-reviewer
        subject:
          expression: "$.gate.output"
      block_when:
        expression: "$.gate.decision = 'fail'"
      feedback:
        expression: "$.gate.feedback"
    - id: acceptance
      type: quality-gates.agent_review
      input:
        review_agent: change-acceptance-reviewer
        subject:
          expression: "$.gate.output"
      block_when:
        expression: "$.gate.decision = 'fail'"
      feedback:
        expression: "$.gate.feedback"
  repair:
    attempts:
      expression: "$.config.implementation.validation.repair_attempts"
```

The referenced agent must declare `mode: trusted_local_write` in
`agent.yaml`. `trusted_host_local` runs on the host and can edit files in the
worktree. Use it only for agents and repositories you trust.

Configure gates in `workflows/<id>/workflow.yaml` under the pattern node's
`gates:` list. Supported gates:

- `quality-gates.validation_commands`: runs deterministic commands and blocks
  on failed validation.
- `quality-gates.agent_review`: runs a read-only agent as a gate. Configure
  `input.review_agent` on the workflow gate entry. The referenced
  `agents/<id>/agent.yaml` owns the agent instructions and output schema.

Workflow `agent` gate expressions:

- `block_when.expression`: JSONata evaluated against the gate agent output. It
  must return a boolean. `true` blocks; `false` passes.
- `feedback.expression`: optional JSONata evaluated against the gate agent
  output only when the gate blocks. Its result is serialized as repair
  feedback.

When any gate fails, Luna sends previous validation, gate feedback, and diff
summary back to the trusted write agent for a repair attempt. In write
workflows, use deterministic built-ins after agent or pattern nodes to record
lifecycle gates used by workspace preserve/cleanup decisions.

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
  invocation:
    expression: "$.invocation"
  context:
    expression: "$.steps.context"
  plan:
    expression: "$.steps.review_plan"
  findings:
    expression: "$.steps.validate_findings"
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
npm test -- tests/core/workflow/definition.test.ts tests/core/workflow/graph-analysis.test.ts tests/core/configured-workflow-runner.test.ts
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```
