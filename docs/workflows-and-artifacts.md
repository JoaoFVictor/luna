# Workflows And Artifacts

This document covers Luna's workflow definition, compilation, execution,
resume, and artifact model.

## Definition Files

A workflow lives under `workflows/<id>/`:

```text
workflows/<id>/
  workflow.yaml
  input.schema.json
  output.schema.json
  config.schema.json   # optional, only when workflow.yaml declares config
```

`workflow.yaml` is strict. Unknown top-level, node, gate, policy, or artifact
fields fail during loading. The directory name and workflow `id` must match.
Schema paths are resolved inside the workflow directory and path escapes are
rejected.

Important top-level fields:

- `mode`: `read_only` or `trusted_local_write`.
- `capabilities`: unqualified capability ids, such as `agents` or `reports`.
- `nodes`: the DAG.
- `execution.max_concurrency`: safe ready-node parallelism.
- `observability.exporters.runtime_log`: optional runtime log projection.
- `requires.repository`: whether invocation repository resolution is required.
- `subagent_policy`: workflow-level delegation policy.
- `config`: optional workflow runtime config declaration.

Runtime config is generic and workflow-owned:

```yaml
config:
  file: code-review.yaml
  schema: config.schema.json
```

The native runtime resolves `file` under `config/`, resolves `schema` inside
the workflow directory, validates the YAML with that JSON Schema, and exposes
the result as `$.config`. Workflows without `config` receive `{}`. Do not add
runtime branches like "if workflow id is X load Y"; the workflow declaration is
the contract. See [Workflow runtime config](workflow-runtime-config.md) for
complete examples and agent-facing rules.

## Node Types

Supported node types:

- `built_in`: calls a registered capability built-in.
- `agent`: calls a reusable agent and validates structured JSON output.
- `pattern`: calls a registered workflow pattern.
- `human_gate`: creates a resumable interrupt backed by a gate registration.

Dependencies are declared with `after`. Duplicate node ids, missing
dependencies, and cycles fail graph analysis.

Final workflow output is derived from terminal node outputs. One terminal node
returns that output. Multiple terminal nodes return an object keyed by terminal
node id. Workflow YAML does not have a separate `output:` mapping.

## Expressions

Dynamic values use expression objects:

```yaml
input:
  invocation:
    expression: "$.invocation"
  context:
    expression: "$.steps.context"
```

Plain strings are literals, not interpolation. Validation rejects string
expressions. Local expression roots are constrained by the capability schema or
policy being configured.

Common roots:

- `$.invocation`
- `$.config`
- `$.repository`
- `$.run`
- `$.workspace`
- `$.steps.<node-id>`

For workflow config, reference the validated shape declared by that workflow's
`config.schema.json`:

```yaml
input:
  enabled:
    expression: "$.config.code_review.pull_request_review.enabled"
```

## Capabilities And Policies

Workflow nodes can only reference ids from declared capabilities. Built-ins,
patterns, gates, policies, artifact publishers, and schema references are
validated through the capability registry.

Side-effecting built-ins must declare an explicit node policy:

```yaml
policies:
  - uses: git.commit_side_effect
    config:
      operation_id: git.commit
```

The policy id and operation id must match the capability manifest. This is how
the runtime knows a step is read-only, write-side-effecting, retryable, or
requires adoption semantics.

The compiler also rejects protected side-effect operations that are not ordered
after approval in trusted write flows.

Provider-backed publishing follows the same rule. For example,
`pull-request-review.publish` is a provider-neutral capability built-in with a
write side-effect policy. The workflow owns when it runs and what state it
passes; the provider owns how GitHub, or another source system, performs the
external API call.

## Compilation And Scheduling

Workflow loading lives in `src/core/workflow/definition.ts`. Compilation lives
in `src/core/workflow/compiler.ts`. Execution lives primarily in
`src/runtime/workflow/**`, with the current workflow runtime adapter under
`src/runtime/langgraph/**`.

Compilation records node capability ids, output schemas, execution policy,
interrupt capability, and edges. It rejects unsafe combinations such as:

- fan-in from independent parallel branches without an object-merge reducer.
- parallel branches that can create multiple pending human interrupts.
- protected side-effect operations before approval.

At runtime, the scheduler:

- chooses dependency-ready nodes.
- respects `execution.max_concurrency`.
- avoids artifact path collisions in the same batch.
- serializes agent sessions with an `agent_session` exclusion key.
- serializes workspace capture.
- applies built-in metadata locks for repository-sensitive steps.
- validates node output schemas and checkpoint-safe JSON.
- records state in checkpoints and emits events.
- runs deferred final-report nodes after the main graph where metadata asks for
  that lifecycle behavior.

## Patterns And Gates

`quality-gates.gated_agent_loop` is the trusted local write pattern used by the
implementation workflow. It runs a writer agent, deterministic validation,
optional diff checks, optional review agents, and repair attempts.

Current quality-gate ids:

- `quality-gates.validation_commands`
- `quality-gates.agent_review`
- `quality-gates.non_empty_diff`

Agent-review gates configure `input.review_agent`, `block_when.expression`, and
optional `feedback.expression` on the workflow gate entry. Gate policy stays in
workflow YAML, not in the reusable agent.

Repair attempts are not transport retries. `repair.attempts` controls how many
times validation or review feedback loops back to the writer. Trusted write
loops should not replay unknown write attempts through generic model retry.

## Human Gates And Resume

`human_gate` nodes compile to interrupt-capable nodes. The native CLI exposes
resume through:

```bash
npm run dev -- resume --target workflow:<id> --thread <run-id> --checkpoint <checkpoint-id> --interrupt <interrupt-id> --decision '<json>'
```

Resume reloads the workflow definition, recompiles it, loads the checkpoint,
reconstructs invocation/run context from checkpoint metadata, applies the
decision, and continues the scheduler.

## Artifacts

Artifact plans are declared on nodes:

```yaml
artifacts:
  - path: final-report.md
    publisher: artifacts.manifest_publisher
    source:
      expression: "$.steps.final_report.markdown"
    format: markdown
    required: true
```

Artifact paths must be safe relative paths under:

```text
<app.artifacts.root>/<workflow-id>/<run-id>/
```

Artifact sources must stay under `$.steps.<declaring-node>...`. Formats are
`json` and `markdown`. `required` defaults to true. The publisher uses
transactional stores for content, manifests, and journals, then appends artifact
refs to runtime state.

Common runtime artifacts include `invocation.json`, `run.json`, `events.jsonl`,
`trace.jsonl`, `observability-summary.json`, node artifacts, interrupt data,
and final reports.

The bundled `code-review` workflow also writes `pull-request-review.json` when
its publish node runs. If publishing is disabled, that artifact records a
skipped result rather than silently disappearing.

## Source Map

- Definition loading: `src/core/workflow/definition.ts`
- YAML schema parsing: `src/core/workflow/definition-schema.ts`
- Capability validation: `src/core/workflow/definition-validation.ts`
- Graph analysis: `src/core/workflow/graph-analysis.ts`
- Compilation: `src/core/workflow/compiler.ts`
- Final output: `src/core/workflow/runner-output.ts`
- Execution policy: `src/core/workflow/execution-policy.ts`
- Runtime scheduler: `src/runtime/workflow/runner-engine.ts`
- Node runner: `src/runtime/workflow/node-runner.ts`
- LangGraph adapter: `src/runtime/langgraph/workflow-runner.ts`
- Artifact publisher: `src/capabilities/artifacts/publisher.ts`
- Gated loop: `src/capabilities/quality-gates/gated-agent-loop.ts`
- Pattern executor: `src/capabilities/quality-gates/workflow-pattern-executor.ts`
