---
name: luna-create-workflow
description: Use when creating or modifying Luna workflow YAML under workflows/, including workflow.yaml, graph.yaml, input and output schemas, built-in nodes, agent nodes, agent_loop nodes, artifacts, state references, and workflow routing.
---

# Luna Create Workflow

Read `examples/new-workflow.md` first. Workflows are YAML graphs; do not create a
TypeScript workflow entrypoint for each workflow.

## Files

```text
workflows/<workflow-id>/
  workflow.yaml
  graph.yaml
  input.schema.json
  output.schema.json
```

Rules:

- Directory name and `workflow.yaml` `id` must match.
- `mode` is `git_managed_read_only` or `git_managed_write`.
- Paths must stay inside the workflow directory.
- Artifact directories always resolve to
  `<app.artifacts.root>/<workflow-id>/<run-id>/`; workflow YAML must not define
  a separate artifact namespace.
- Optional `execution.max_concurrency` controls safe ready-node parallelism.
  Repository-sensitive built-ins remain serialized by local locks, and
  `agent`/`agent_loop` nodes must use explicit workflow dependencies and
  artifacts instead of shared mutable local state.

## Node Types

- `built_in`: deterministic runtime capability from `src/core/built-ins/catalog.ts`.
- `agent`: reusable model worker from `agents/<id>/`.
- `agent_loop`: trusted local write agent with validation/repair.

Use `after` dependencies for ordering. Duplicate ids, unknown dependencies, and
cycles are invalid.

Use `collect_context` when a workflow should pass configured repository or
agent context files to model nodes. Write `context-intake.json` as an artifact,
list every agent/agent_loop that consumes context in `input.agents`, and pass
`context: $.steps.context` explicitly to those nodes. Luna promotes collected
context into runtime instructions, ordered as agent-owned context before
repository context, and keeps only `context_audit` metadata in task input.

For `git_managed_write` workflows, keep lifecycle decisions in deterministic
built-ins. If an agent or agent-loop output participates in workspace
preserve/cleanup decisions, add a built-in node after it to record the typed
lifecycle gate. Built-ins expose lifecycle metadata through their TypeScript
registry definitions.

## Artifacts

Workflow nodes write files through explicit `artifacts` plans:

```yaml
artifacts:
  - path: output.json
    source: $.steps.node_id
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
- Put orchestration in graph YAML, not in prompts.
- Create or reuse agents for model judgment.
- Create built-ins for deterministic workflow capabilities.
- Keep context intake explicit in the graph; do not make agents or Flue discover
  repository guidance implicitly.
- Create adapters for new external input sources.

## Testing

Run:

```sh
rtk npm test -- tests/core/workflow-definition.test.ts tests/core/configured-workflow-runner.test.ts
rtk npm run typecheck
rtk npm run typecheck:unused-src
rtk npm run lint:unused
```
