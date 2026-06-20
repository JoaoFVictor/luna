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
- `artifacts.root_namespace` controls `.runs/<namespace>/<run-id>/`.

## Node Types

- `built_in`: deterministic runtime capability from `src/core/built-ins/catalog.ts`.
- `agent`: reusable model worker from `agents/<id>/`.
- `agent_loop`: trusted local write agent with validation/repair.

Use `after` dependencies for ordering. Duplicate ids, unknown dependencies, and
cycles are invalid.

## State References

Node `input` can reference:

- `$.invocation`
- `$.repository`
- `$.run`
- `$.workspace`
- `$.config.implementation`
- `$.steps.<node-id>`

## Design Rules

- Keep routing deterministic through CLI target, invocation target, or config.
- Put orchestration in graph YAML, not in prompts.
- Create or reuse agents for model judgment.
- Create built-ins for deterministic workflow capabilities.
- Create adapters for new external input sources.

## Testing

Run:

```sh
npm test -- tests/core/workflow-definition.test.ts tests/core/configured-workflow-runner.test.ts
npm run typecheck
```
