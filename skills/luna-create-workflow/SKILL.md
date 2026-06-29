---
name: luna-create-workflow
description: Use when creating or modifying Luna workflow YAML under workflows/, including workflow.yaml, schemas, nodes, capabilities, policies, expressions, artifacts, gates, HITL, routing, and workflow tests.
---

# Luna Create Workflow

Workflows are strict YAML DAGs. Do not create a TypeScript workflow entrypoint
for each workflow.

## Files

```text
workflows/<workflow-id>/
  workflow.yaml
  input.schema.json
  output.schema.json
  config.schema.json   # optional when workflow.yaml declares config
```

Rules:

- Directory name and `workflow.yaml` `id` must match.
- `mode` is `read_only` or `trusted_local_write`.
- `capabilities:` uses unqualified ids, such as `agents` or `reports`.
- Node `uses:` values use namespaced capability ids, such as
  `reports.final_report`.
- Unknown fields fail.
- Schema paths must stay inside the workflow directory.
- Runtime config is optional and workflow-declared:
  `config.file` points at a YAML file under `config/`, `config.schema` points
  at `workflows/<workflow-id>/config.schema.json`, and values are available as
  `$.config`. Full contract: `docs/workflow-runtime-config.md`.
- Do not add workflow-specific TypeScript loaders or CLI commands for config.

## Node Types

- `built_in`: deterministic capability operation.
- `agent`: reusable model role from `agents/<id>/`.
- `pattern`: reusable workflow pattern such as
  `quality-gates.gated_agent_loop`.
- `human_gate`: resumable interrupt such as `hitl.approval`.

Use `after` for dependencies. Duplicate ids, unknown dependencies, cycles, and
unsafe parallel interrupt/fan-in shapes fail validation or compilation.

## Expressions

Use expression objects:

```yaml
input:
  context:
    expression: "$.steps.context"
```

Do not use string interpolation. Plain strings are literals.

## Policies

Side-effecting built-ins must declare a matching policy:

```yaml
policies:
  - uses: git.push_branch_side_effect
    config:
      operation_id: git.push_branch
```

## Gates

`quality-gates.gated_agent_loop` gate policy lives on the pattern node.

Current quality gates:

- `quality-gates.validation_commands`
- `quality-gates.agent_review`
- `quality-gates.non_empty_diff`

For agent review gates, configure `input.review_agent`,
`block_when.expression`, and optional `feedback.expression` in workflow YAML.
Do not put gate policy in agent config.

## Context And Artifacts

If a model node needs repository or agent context, run
`context.collect_context`, write `context-intake.json`, and pass
`context: { expression: "$.steps.context" }`.

Artifact sources must stay under `$.steps.<declaring-node>...`; formats are
`json` and `markdown`.

## Testing

Run workflow definition/compiler/runner tests relevant to the change, then:

```bash
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```
