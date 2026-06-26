# Workflows And Artifacts

This document explains Luna's deterministic orchestration layer: YAML workflow
graphs, scheduler state, gates, artifacts, and finalization.

## What A Workflow Is

A workflow is a YAML DAG under `workflows/<id>/`. It describes what runs, in
what order, which state each node receives, and which artifacts each node
writes.

The usual files are:

```text
workflows/<id>/
  workflow.yaml
  input.schema.json
  output.schema.json
```

There is still only one TypeScript workflow entrypoint:
`src/workflows/luna.ts`. New workflows should be new YAML directories, not new
TypeScript workflow files.

## Runtime Path

The workflow runtime path is:

```text
CLI or adapter -> Invocation -> routeInvocation -> workflow YAML -> runConfiguredWorkflow -> scheduler -> artifacts and finalization
```

`runConfiguredWorkflow` loads configuration, routes the invocation, loads the
workflow definition, creates run identity and artifact writers, resolves the
repository when required, schedules graph nodes, writes planned artifacts,
finalizes workspace state, and runs deferred final-report nodes.

## Node Types

`built_in` nodes call deterministic TypeScript steps registered in the built-in
registry.

`agent` nodes call reusable agent definitions and validate structured model
output.

`pattern` nodes run reusable workflow patterns such as
`quality-gates.gated_agent_loop` for trusted local write agents with validation
and gate repair loops. Trusted write patterns are only valid in trusted write
workflows.

Read-only workflows cannot use trusted write patterns or write lifecycle built-ins.
Trusted write workflows must still declare their write behavior explicitly in
the graph and implementation config.

## State And References

The scheduler state contains:

- `invocation`
- flattened runtime `config`
- optional resolved `repository`
- `run` identity
- workflow metadata
- optional `workspace`
- previous `steps`
- workspace, agents, and workflow roots
- lifecycle evidence

Node inputs are explicit. Dynamic values must use an expression object:
`{ expression: "$.steps.<node-id>" }`. Supported roots are `$.invocation`,
`$.config`, `$.repository`, `$.run`, `$.workspace`, and `$.steps.<node-id>`.

This is not arbitrary string interpolation. Prefer explicit fields over hiding
state lookup inside prose.

## Scheduler Behavior

The scheduler validates graph shape before execution: duplicate ids, unknown
dependencies, dependency cycles, unsafe graph paths, unknown built-ins, invalid
artifact plans, and mode violations are rejected.

During execution it:

- chooses ready node batches according to dependency and execution policy.
- respects `execution.max_concurrency`.
- prevents unsafe concurrent agent sessions and workspace capture.
- uses repository locks for repository-sensitive steps.
- snapshots state before node execution in development.
- records lifecycle evidence from built-in metadata.
- writes planned artifacts before adding the node output to `state.steps`.
- skips dependents when a dependency fails.

`events.jsonl` is mandatory for observability. `runtime_log` is the optional
exporter.

## Artifacts

Run artifacts are written under:

```text
<app.artifacts.root>/<workflow-id>/<run-id>/
```

Common runtime files include:

- `invocation.json`
- `run.json`
- `events.jsonl`
- `observability-summary.json`
- planned node artifacts
- final reports
- failure artifacts when a run fails

Artifact plans are declared on nodes. Paths must be safe relative paths.
Sources must reference the declaring node output with `$.steps.<node-id>`.
Formats are JSON or Markdown. Artifacts default to required unless the plan
sets `required: false`.

Keep artifact paths simple and flat unless runtime support changes. The
artifact store writes into the run directory and should remain inspectable by a
person after the run.

## Gated Agent Loops

A `gated_agent_loop` is for trusted local write work. The writer agent must
declare `mode: trusted_local_write`, and the node sandbox must be
`trusted_host_local`.

Current gates are:

- `validation_commands`: deterministic commands from implementation config.
- `agent`: a read-only review or acceptance agent.

For an agent gate, put `block_when.expression` and optional
`feedback.expression` in the workflow gate entry. Do not put gate policy in
`agents/<id>/agent.yaml`. `block_when.expression` must evaluate to a boolean.

Gate repair attempts are not transport retries. `repair.attempts` controls how
many times failed validation or gate feedback loops back to the writer.
`retry.max_attempts` is prompt replay policy, and trusted write loops reject
prompt replay above one attempt because replaying a write prompt after an
unknown transport failure is not safe.

Use one `validation_commands` gate per loop. The current runner uses the first
validation gate as the command source.

## Finalization

Built-in metadata can mark a node as a deferred final report. The runner splits
those nodes out, runs the main graph first, finalizes the workspace, and then
runs final-report nodes with final workspace disposition available.

`workspace.json` may be rewritten during finalization. Treat it as the final
workspace state, not just the state at worktree creation time.

`run.json` is strict identity and should stay small. Put summaries in
`observability-summary.json` or report artifacts.

## What This Layer Does

- Orchestrates deterministic DAGs.
- Routes explicit workflow state into node inputs.
- Enforces read-only versus trusted write workflow mode.
- Writes inspectable artifacts.
- Applies built-in metadata for locks, lifecycle, workspace capture, and
  deferred final reports.
- Keeps final workspace state visible.

## What This Layer Does Not Do

- It does not add per-workflow TypeScript entrypoints.
- It does not let agents discover context implicitly.
- It does not ask a model to choose workflow routing.
- It does not use arbitrary JSONPath in artifact sources.
- It does not treat workflow input and output schema files as the scheduler's
  active runtime validators.

## Source Map

- Workflow definitions: `src/core/workflow/definition.ts`
- Scheduler: `src/core/workflow/scheduler.ts`
- Execution policy: `src/core/workflow/execution-policy.ts`
- State references: `src/core/workflow/state.ts`
- Artifact plans: `src/core/workflow/artifact-write-plan.ts`
- Configured runner: `src/core/configured-workflow/runner.ts`
- Node runner: `src/core/configured-workflow/node-runner.ts`
- Bootstrap: `src/core/configured-workflow/bootstrap.ts`
- Finalization: `src/core/configured-workflow/finalization.ts`
- Routing definition: `src/core/router/router-definition.ts`
- Routing evaluator: `src/core/router/router.ts`
- Artifact store: `src/core/artifacts/store.ts`
- Gated loop types: `src/core/agents/gated-loop-runner.ts`

Useful tests include `tests/core/workflow/definition.test.ts`,
`tests/core/workflow/definition-output.test.ts`,
`tests/core/workflow/graph-analysis.test.ts`,
`tests/core/workflow-scheduler.test.ts`,
`tests/core/workflow-execution-policy.test.ts`,
`tests/core/artifact-write-plan.test.ts`,
`tests/core/configured-workflow-runner.test.ts`,
`tests/core/router/router.test.ts`, `tests/core/workflow-state.test.ts`,
`tests/core/gated-agent-loop-runner.test.ts`, and
`tests/core/flue-gated-agent-loop-retry.test.ts`.
