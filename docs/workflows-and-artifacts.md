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
- `loop`: runs a sequential body ending in one human gate until its declared
  repeat condition is false.
- `workflow`: synchronously calls another installed workflow by id.

Workflow composition remains YAML-owned and does not create a capability or a
per-workflow TypeScript entrypoint:

```yaml
- id: enrich
  type: workflow
  workflow: enrich-context
  input:
    subject:
      expression: "$.invocation.subject"
  after: [intake]
```

The child `input_schema` validates the resolved node input and its
`output_schema` validates the value returned as this node's output. Loading
pins the child revision into the parent's external-definition digest and
rejects missing references, composition cycles, read-only parents calling
trusted-write children, or missing repository authority. Synchronous
composition deliberately rejects child graphs that can suspend for human
input; nested HITL requires a future resumable composition protocol rather
than an implicit or unsafe fallback. Child runtime checkpoints use a
deterministic identity derived from the parent run and call-node id, while the
control plane keeps one historical parent run.

Dependencies are declared with `after`. Duplicate node ids, missing
dependencies, and cycles fail graph analysis.

Node ids also share an internal namespace with the LangGraph scheduler. They
must not start with `__luna_`, equal `__start__` or `__end__`, contain `:` or
`|`, or equal a runtime state field such as `steps`, `run`, `attempts`, or
`artifact_refs`. Definition validation and compilation both reject these ids
before execution, rather than accepting a workflow that the runtime graph
cannot construct.

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

## Code Review Workflow Shape

`code-review` uses deterministic evidence collection, a related-context impact
graph, and a logical multi-reviewer fan-out with deterministic fan-in:

1. `review.coverage_plan` extracts `expected_review_ranges` from captured
   repository diff evidence and records blocked ranges such as binary, deleted,
   truncated, or uncaptured files.
2. `repository-context.related_context` builds a bounded, auditable graph around
   changed files: changed nodes, import/include dependencies, reverse
   references, tests, configs, docs, nearby files, and similar abstractions.
   The graph currently has deterministic JS/TS/PHP-friendly heuristics,
   including `paths`, `baseUrl`, common root aliases, and Composer PSR-4, and
   records budgets/truncation so incomplete context is visible.
3. `review-planner` narrows the review scope from invocation, repository diff
   context, coverage, and related context.
4. `change-reviewer`, `security-reviewer`, and `architecture-reviewer` run from
   the same plan, repository evidence, coverage plan, and related context.
5. `findings.merge` combines those reviewer outputs, computes deterministic
   fingerprints, preserves source provenance, unions reviewed ranges, and
   deduplicates matching findings without using a model.
6. `review.coverage_check` compares expected review ranges with reviewer
   reported ranges and returns `missing_review_ranges` so partial or blocked
   review scope remains visible. This is an auditable reviewer declaration, not
   proof that a model understood every changed line.
7. `findings.validate_evidence` checks the merged findings against captured
   repository evidence.
8. `review.quality_check` turns deterministic coverage, related-context,
   truncation, and publishable-evidence signals into `pass`,
   `needs_human_review`, or `blocked`.
9. `change-acceptance-reviewer` evaluates the validated result, coverage,
   related context, and deterministic review quality.
10. `pull-request-review.publish` optionally publishes a formal PR review from
   the validated findings and acceptance result.

To add another review lens, create a reusable read-only agent with the standard
findings output schema, add it to `context.collect_context`, pass
`coverage_plan` and `related_context`, run it after `review_plan`, and append
its named step output to `merged_findings.input.sources`. Downstream validation
and PR publication should keep reading from `$.steps.validated_findings`;
acceptance should also receive `$.steps.coverage_check` and
`$.steps.related_context`, plus `$.steps.review_quality` when the workflow uses
the quality gate.

## Compilation And Scheduling

Workflow loading lives in `src/core/workflow/definition.ts`. Compilation lives
in `src/core/workflow/compiler.ts`. Execution lives primarily in
`src/runtime/workflow/**`, with the current workflow runtime adapter under
`src/runtime/langgraph/**`.

Compilation records node capability ids, output schemas, execution policy,
interrupt capability, and edges. It rejects unsafe combinations such as:

- fan-in from independent parallel branches without an object-merge reducer.
- any interrupt-capable node that is not dependency-ordered with every other
  node. Independent siblings are rejected with
  `workflow_parallel_hitl_unsupported`, because a sibling failure cannot race
  an already-durable human wait.
- protected side-effect operations before approval.

At runtime, the scheduler:

- chooses dependency-ready nodes.
- respects `execution.max_concurrency`.
- avoids artifact path collisions in the same batch.
- serializes agent sessions with an `agent_session` exclusion key unless native
  compilation has verified a read-only agent and workflow
  `execution.agent_sessions.read_only: shared` opts into shared read-only
  sessions. `execution.max_concurrency` remains the batch-size limit.
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

Agent-review gates configure the static `input.review_agent`,
`block_when.expression`, and optional `feedback.expression` on the workflow
gate entry. If the reviewer declares context files, the workflow must collect
that agent in `context.collect_context`, make the pattern depend on the
collector, and pass `input.context.expression: "$.steps.<collector>"` on that
specific gate. Gate policy stays in workflow YAML, not in the reusable agent.

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
decision, and continues the scheduler. Until concurrent HITL outcome merging
has an explicit contract, every interrupt-capable node must be ordered before
or after every other node in the workflow graph.

## Durable Human Review Loops

A `loop` body is a single sequential chain ending in exactly one `human_gate`.
Its `repeat_when` expression decides whether the human response starts another
iteration; no implicit iteration limit exists. `when` on body agents and
built-ins supports selective regeneration and retains the previous output when
the node is not selected. `result` projects the terminal business value.
Optional `halt_when` evaluates only that result and can finish the workflow
successfully without scheduling downstream nodes, for example after rejection.

Each iteration has a deterministic execution identity, interrupt, checkpoint,
and artifact namespace. Resume recovery reuses persisted node outputs rather
than replaying completed work. Binary assets remain content-addressed artifacts
and only opaque references enter loop state.

## Artifacts

Artifact plans are declared on nodes:

```yaml
artifacts:
  - path: code-review-findings.json
    publisher: artifacts.manifest_publisher
    semantic_type: luna.review.findings.v1
    source:
      expression: "$.steps.validated_findings"
    format: json
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

`semantic_type` is optional manifest metadata for consumers that can validate
and present a known artifact schema. It is a lowercase, namespaced id ending in
an explicit positive version such as `.v1`, and is limited to 128 characters.
It does not change routing, execution, or the artifact bytes. Producers must
only declare a semantic type when the published source really matches that
versioned contract; incompatible payload changes require a new `.vN` id.
Consumers must validate the content and fall back to the
generic preview for missing, unknown, or schema-invalid semantic types. Legacy
manifests without this field remain valid.

The Studio currently recognizes these versioned JSON contracts:

| `semantic_type` | Specialized presentation |
| --- | --- |
| `luna.review.findings.v1` | Findings, severity, confidence, safe evidence ranges, and recommendations |
| `luna.review.coverage-plan.v1` | Planned coverage totals and blocked ranges |
| `luna.review.coverage-check.v1` | Reviewed, missing, and blocked coverage totals |
| `luna.review.acceptance.v1` | Acceptance status, recommended action, and blocking reasons |
| `luna.review.provider-publish.v1` | Provider publication status and comment totals |
| `luna.implementation.worktree.v1` | Worktree lifecycle, repository, branch, and abbreviated base revision |
| `luna.implementation.plan.v1` | Implementation summary, steps, files, validation plan, and risks |
| `luna.implementation.gates.v1` | Attempt, validation, and gate summaries |
| `luna.implementation.validation.v1` | Command exit, timeout, duration, and truncation summaries |
| `luna.implementation.diff.v1` | Changed-file statuses and diff truncation totals |
| `luna.implementation.commit.v1` | Commit or commit-lifecycle result |
| `luna.implementation.push.v1` | Push or push-lifecycle result |
| `luna.implementation.change-request.v1` | Change-request creation or skip result |

Specialized views use bounded strict schemas and render React text only. They do
not render raw command output, diff patches, evidence quotes, physical worktree
paths, provider URLs, HTML, SVG, or Markdown. The generic inline fallback also
redacts physical paths. Raw downloads deliberately remain original bytes and
the Studio labels that boundary explicitly.

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
