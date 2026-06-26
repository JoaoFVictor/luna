---
name: luna-create-workflow
description: Use when creating or modifying Luna workflow YAML under workflows/, including workflow.yaml, input and output schemas, built-in nodes, agent nodes, pattern nodes, artifacts, state references, gates, and workflow routing.
---

# Luna Create Workflow

Read `examples/new-workflow.md` first. Workflows are YAML graphs; do not create a
TypeScript workflow entrypoint for each workflow.

## Files

```text
workflows/<workflow-id>/
  workflow.yaml
  input.schema.json
  output.schema.json
```

Rules:

- Directory name and `workflow.yaml` `id` must match.
- `mode` is `read_only` or `trusted_local_write`.
- Paths must stay inside the workflow directory.
- Artifact directories always resolve to
  `<app.artifacts.root>/<workflow-id>/<run-id>/`; workflow YAML must not define
  a separate artifact namespace.
- Optional `execution.max_concurrency` controls safe ready-node parallelism.
  Optional `execution.lock_timeout_ms` tunes local lock acquisition. Repository-
  sensitive built-ins remain serialized by local locks, and `agent`/pattern
  nodes must use explicit workflow dependencies and artifacts instead of shared
  mutable local state.
- Optional `observability.exporters.runtime_log` controls the runtime log sink.
  Do not configure `observability.exporters.jsonl`; `events.jsonl` is mandatory
  and always written.
- Optional `subagent_policy.allow_write` controls whether trusted write
  subagents may be materialized for this workflow.

## Node Types

- `built_in`: deterministic runtime capability from the active built-in
  registry.
- `agent`: reusable model worker from `agents/<id>/`.
- `pattern`: reusable workflow pattern such as
  `quality-gates.gated_agent_loop`.

`quality-gates.gated_agent_loop` gates are generic and ordered. Configure them
in `workflows/<id>/workflow.yaml` under the pattern node's `gates:` list.
Supported gate types:

- `quality-gates.validation_commands`: runs deterministic validation commands
  and blocks when validation fails.
- `quality-gates.agent_review`: runs a read-only gate agent. Configure
  `input.review_agent` on this workflow gate entry; the referenced agent only
  owns instructions, tools, context, and output schema.

Workflow agent-review gate expressions:

- `block_when.expression`: JSONata evaluated against the gate agent output. It
  must return a boolean. `true` blocks; `false` passes.
- `feedback.expression`: optional JSONata evaluated against the gate agent
  output only when the gate blocks. Its result is serialized as repair
  feedback.

Do not put `block_when`, `feedback`, or gate policy in
`agents/<id>/agent.yaml`; agents stay reusable across workflows.

When any gate fails, Luna reruns the trusted write agent in repair mode with
previous validation, gate feedback, and diff summary. Keep gate policy generic;
provider-specific behavior belongs in adapters/providers, not in gates.

Use `after` dependencies for ordering. Duplicate ids, unknown dependencies, and
cycles are invalid.

Agent nodes may declare `retry`. Read-only agent nodes can retry transient
runtime failures. Trusted write gated agent loops use `repair.attempts` for
validation repair and reject retry semantics that would replay local file
writes.

Use `collect_context` when a workflow should pass configured repository or
agent context files to model nodes. Write `context-intake.json` as an artifact,
list every agent or pattern worker that consumes context in `input.agents`, and
pass `context: { expression: "$.steps.context" }` explicitly to those nodes.
Luna promotes collected context into runtime instructions, ordered as
agent-owned context before repository context, and keeps only `context_audit`
metadata in task input.

For `trusted_local_write` workflows, keep lifecycle decisions in deterministic
built-ins. If an agent or `gated_agent_loop` output participates in workspace
preserve/cleanup decisions, add a built-in node after it to record the typed
lifecycle gate. Built-ins expose lifecycle metadata through their TypeScript
registry definitions.

## Artifacts

Workflow nodes write files through explicit `artifacts` plans:

```yaml
artifacts:
  - path: output.json
    publisher: artifacts.manifest_publisher
    source:
      expression: "$.steps.node_id"
    format: json
    required: true
```

`format` is `json` or `markdown`. `required` defaults to `true`.
Artifact sources must start with `$.steps.<node-id>` and may use plain dot
property segments such as `$.steps.final_report.markdown`.

## State References

Node `input` can reference:

- `$.invocation`
- `$.repository`
- `$.run`
- `$.workspace`
- `$.config.implementation`
- `$.steps.<node-id>`

Use `$.steps.context` for the output of `collect_context`.

## Design Rules

- Keep routing deterministic through CLI target, invocation target, or config.
- Put orchestration in workflow YAML `nodes:`, not in prompts.
- Create or reuse agents for model judgment.
- Create built-ins for deterministic workflow capabilities.
- Keep context intake explicit in the graph; do not make agents or Pi discover
  repository guidance implicitly.
- Create adapters for new external input sources.

## Testing

Run:

```sh
npm test -- tests/core/workflow/definition.test.ts tests/core/workflow/graph-analysis.test.ts tests/core/workflow/runner.test.ts
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```
