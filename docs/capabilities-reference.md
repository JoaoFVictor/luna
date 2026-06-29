# Capabilities Reference

Capabilities are Luna's public registry for deterministic behavior. Workflow
YAML references capability ids. Agent tool resolution also uses capability
registrations. Treat manifests as the source of truth.

Source files:

- Official registry: `src/capabilities/registry.ts`
- Manifest contract: `src/core/capabilities/manifest.ts`
- Registry validation: `src/core/capabilities/registry.ts`

## Registry Rules

The registry validates:

- unique capability ids.
- declared dependencies.
- dependency cycles.
- duplicate public registration ids.
- references to built-ins, patterns, gates, tools, policies, ports, schemas,
  and artifact publishers.
- re-export references.
- write side-effect policy metadata.
- duplicate side-effect operation ids.

Workflow YAML declares unqualified capability ids:

```yaml
capabilities:
  - reports
```

Nodes reference qualified registrations:

```yaml
uses: reports.final_report
```

## Official Capabilities

| Capability | Purpose |
| --- | --- |
| `agents` | Agent runtime ports and agent node schemas. |
| `artifacts` | Artifact publisher and artifact reference schemas. |
| `context` | Repository and agent context intake. |
| `runtime` | Runtime preflight. |
| `repository-diff` | Read-only repository diff/context collection. |
| `findings` | Evidence validation for code review findings. |
| `reports` | Generic final report generation. |
| `pull-request-review` | Pull request review publication with inline comments. |
| `quality-gates` | Gated agent loop pattern and automated gates. |
| `validation` | Validation command execution. |
| `repository-change` | Trusted write worktree, validation, diff, commit, push lifecycle helpers. |
| `task-context` | Provider task context and final implementation reports. |
| `hitl` | Human approval gate and approval enforcement. |
| `repository` | Agent-local repository tools. |
| `local-exec` | Host command execution built-ins and ports. |
| `repository-workspace` | Read-only repository workspace capture. |
| `git` | Git status, commit, and push built-ins. |
| `change-request` | Change-request creation built-in and provider port. |
| `repository-write` | Bundle/re-export for trusted repository write capabilities. |

## Built-Ins

Runtime, context, and reports:

- `runtime.preflight`
- `context.collect_context`
- `repository-diff.collect_context`
- `findings.validate_evidence`
- `reports.final_report`
- `pull-request-review.publish`
- `task-context.collect`
- `task-context.final_report`

Validation and HITL:

- `validation.run_commands`
- `hitl.require_approval`

Repository workspace/change lifecycle:

- `repository-workspace.capture`
- `repository-change.prepare_worktree`
- `repository-change.record_validation`
- `repository-change.collect_worktree_diff`
- `repository-change.record_acceptance_decision`
- `repository-change.prepare_commit`
- `repository-change.record_commit_lifecycle`
- `repository-change.prepare_push`
- `repository-change.record_push_lifecycle`

Host execution and publishing side effects:

- `local-exec.command.read`
- `local-exec.command.write`
- `git.status`
- `git.commit`
- `git.push_branch`
- `change-request.create`
- `pull-request-review.publish`

Provider-specific task context behavior is selected by `invocation.source`
inside provider/native composition; it does not add separate public built-in ids
for each provider.

`pull-request-review.publish` is provider-neutral. It receives the PR identity,
review event, body, optional acceptance result, validated findings, and
repository diff context from workflow state. The capability renders the PR body,
decides which findings can become inline comments, and resolves safe review
event behavior. `auto` requests changes only when validated findings exist;
no-finding request-change attempts and approvals with findings are published as
regular review comments. Provider modules decide how to call the external PR
review API.

## Pattern

`quality-gates.gated_agent_loop`

Used for trusted local write repair loops. It runs a writer agent, validation,
diff summary, gate agents, and repair attempts. The pattern has an
`agent_session` batch exclusion key so the runner does not execute another
agent session concurrently in the same unsafe batch.

## Gates

Quality gates:

- `quality-gates.validation_commands`
- `quality-gates.agent_review`
- `quality-gates.non_empty_diff`

Human gate:

- `hitl.approval`

Quality gates do not create runtime interrupts. `hitl.approval` creates a
required interrupt and must be resumed with a decision.

## Policies

Side-effect policies:

- `local-exec.command_read_policy`
- `local-exec.command_write_policy`
- `repository-workspace.capture_policy`
- `git.status_read_policy`
- `git.commit_side_effect`
- `git.push_branch_side_effect`
- `change-request.create_side_effect`
- `pull-request-review.publish_side_effect`

Workflow nodes that use side-effecting built-ins must declare the matching
policy with `operation_id`.

Examples:

```yaml
policies:
  - uses: git.commit_side_effect
    config:
      operation_id: git.commit
```

`repository-write` re-exports the repository-write policy bundle so workflows
can depend on one higher-level capability when appropriate.

## Local Tools

Repository local tools:

- `repository.status`
- `repository.diff-summary`
- `repository.read-file`
- `repository.write-file`
- `repository.delete-file`

Mode rules:

- `status`, `diff-summary`, and `read-file` are valid for `read_only` and
  `trusted_local_write` agents.
- `write-file` and `delete-file` require `trusted_local_write`.

All local tools are bound to a cwd. Filesystem paths must stay inside that cwd.

MCP tools are derived from `config/mcp.yaml` policy, not from the repository
tool capability. Current bundled config has no MCP servers. The current Pi
adapter supports local tools only.

## Ports

Agent/runtime ports:

- `agents.runtime`

Artifact ports/schemas:

- `artifacts.manifest_store`
- `artifacts.artifact_ref`
- `artifacts.publisher_output`

Validation/local execution ports:

- `validation.runner`
- `local-exec.command_port`
- `local-exec.artifact_publisher`
- `local-exec.event_sink`

Repository/workspace/git ports:

- `repository-workspace.manager`
- `repository-workspace.lock_manager`
- `repository-workspace.event_sink`
- `git.repository`

Provider publishing port:

- `change-request.provider`
- `pull-request-review.provider`

Ports are selected in runtime composition or native executor wiring, not in
agent prompts.

## Artifact Publisher

`artifacts.manifest_publisher`

Artifact rules:

- artifact paths are safe relative paths.
- source expressions must stay under the declaring node's `$.steps.<node>`.
- JSON artifacts must be JSON values.
- Markdown artifacts must be strings.
- required artifacts fail when the source is missing.
- duplicate artifact paths are prevented within a batch.
- default overwrite policy is `forbid`; supported config can use `replace`.

## Workflow Artifact Inventory

`code-review` writes:

- `preflight.json`
- `workspace.json`
- `repo-context.json`
- `context-intake.json`
- `review-plan.json`
- `raw-code-review-findings.json`
- `code-review-findings.json`
- `acceptance-review.json`
- `pull-request-review.json`
- `final-report.json`
- `final-report.md`

`implementation` writes:

- `preflight.json`
- `workspace.json`
- `task-context.json`
- `context-intake.json`
- `implementation-plan.json`
- `implementation-result.json`
- `validation.json`
- `acceptance-review.json`
- `diff.json`
- `prepared-commit.json`
- `git-commit.json`
- `commit.json`
- `prepared-push.json`
- `git-push.json`
- `push.json`
- `change-request.json`
- `final-report.json`
- `final-report.md`

Example workflows write smaller subsets under their own workflow ids.

## Trusted Host-Local Caveat

`local-exec` and trusted repository write flows run on the host. They can
access local filesystem, credentials, network, and CLIs available to the Luna
process. Keep trusted write workflows behind explicit repository config,
validation, review gates, and human approval.
