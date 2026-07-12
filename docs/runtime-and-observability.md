# Runtime And Observability

Luna separates workflow definition from runtime execution. YAML describes the
graph. The native platform loads plugins and config. Runtime composition
chooses concrete backends and runtimes. The scheduler executes compiled nodes
and records observable evidence.

## Runtime Stack

```text
src/cli.ts or src/workflows/luna.ts
  -> src/platform/native/native-platform-loader.ts
  -> src/platform/native/native-workflow-runner.ts
  -> src/runtime/composition/runtime-composition.ts
  -> src/runtime/langgraph/workflow-runner.ts
  -> src/runtime/workflow/runner-engine.ts
  -> node executors, artifacts, events, checkpoints, logs
```

`src/workflows/luna.ts` is deliberately tiny. It loads the native platform and
delegates to `platform.runWorkflow`. The native runner owns workflow loading,
repository resolution, run identity, compilation, agent inputs, executor
wiring, and runtime composition.

Webhook ingress uses a split runtime shape:

```text
POST /webhooks/:provider
  -> provider-owned verification and normalization
  -> BullMQ job in Redis
  -> webhook worker
  -> deterministic routeInvocation
  -> target executor
```

The HTTP process does not route or execute workflows inline. It only checks
readiness, verifies signatures, normalizes an invocation, and enqueues a
BullMQ job. The worker process consumes jobs, routes the invocation with the
same deterministic router used by the CLI, and calls the target executor.

## Native Platform

The native platform is the composition root for bundled runtime behavior.

It registers:

- input adapters.
- agent runtime factories.
- workflow runtime factories.
- built-in executors.
- task-provider built-ins.
- pattern executors.
- provider-backed publishing factories, such as PR review and change-request
  providers.
- capability manifests.

Bundled plugins currently wire:

- `runtime`: Pi agent runtime and LangGraph workflow runtime.
- `quality-gates`: gated-agent-loop pattern executors.
- `github`: GitHub PR adapter, preflight hook, GitHub PR review publishing,
  and GitHub change requests.
- `jira`: Jira task adapter and task/report built-ins.
- `plane`: Plane task adapter and task/report built-ins.

Configured native plugin modules can extend the platform through `app.plugins`.

## Runtime Composition

Runtime composition validates and creates concrete runtime dependencies:

- artifact store.
- event store.
- interrupt store.
- checkpoint store.
- runtime-log store.
- workflow runtime.
- agent runtime.
- interrupt authorization.
- capability ports.
- artifact publisher.
- observability sinks.

`config/app.yaml` selects defaults:

```yaml
artifacts:
  root: .runs
workflow_runtime:
  id: langgraph
agent_runtime:
  id: pi
```

For production-like runs, Luna uses filesystem artifacts/events/interrupts/logs
and SQLite checkpoints under `.runs`. Memory backends exist for tests.

## Webhook Queue Runtime

Webhook server and worker processes require Redis because MVP ingress uses
BullMQ for durable asynchronous handoff.

```bash
redis-server
npm run build
node dist/src/cli.js webhook-server
node dist/src/cli.js webhook-worker
```

For a containerized local runtime, use Compose:

```bash
export HOST_UID="$(id -u)"
export HOST_GID="$(id -g)"
export LUNA_STUDIO_CHECKOUT_ID="$(pwd -P | sha256sum | cut -c1-24)"
install -d -m 0700 .runs .luna/studio
docker compose up --build
```

This starts Redis, `webhook-server`, `webhook-worker`, and `studio`. The
containers use
`REDIS_URL=redis://redis:6379`, keep Redis on the internal Compose network,
expose the HTTP server on host port `4012`, mount `./dist` and `./config`
read-only, mount
`${LUNA_AUTH_ROOT:-./.luna/auth}` at `/app/.luna/auth`, and write run
artifacts to `./.runs`. The auth root is writable because the Pi runtime can
refresh OAuth credentials. Luna services run as the required host
`HOST_UID:HOST_GID`; `.runs` must be created privately by that identity before
startup and Compose never recursively changes a bind mount's ownership. A
read-only preflight requires `.runs` and `.luna/studio` to be owned by
`HOST_UID` with mode `0700`; it fails rather than modifying an unsafe bind.

The Studio is independently startable with `docker compose up --build studio`.
Its production React assets are built into the image, and opening
`http://127.0.0.1:43110` establishes the local browser session automatically.
No token or log lookup is required. The port mapping is
fixed to `127.0.0.1:43110:43110`: the process explicitly opts into a wildcard
listener inside the container bridge, but accepts Host and Origin only for the
public `127.0.0.1:43110` authority. Only this service receives read-write
mounts for `workflows/`, `agents/`, and `config/`; its private drafts and apply
journals persist under `.luna/studio/`, while the SQLite run catalog lives in a
private checkout-scoped named volume at `/var/lib/luna-studio`, outside the
checkout. Compose requires a stable `LUNA_STUDIO_CHECKOUT_ID`, includes it in
the Compose project name, and hashes it again below the state root. The second
namespace remains authoritative if an override shares one physical volume
between checkouts. Local processes use `LUNA_STUDIO_STATE_ROOT` or the per-user
XDG state directory. The state initializer changes only the named-volume root,
non-recursively, to `HOST_UID:HOST_GID` with mode `0700`; it does not alter any
bind mount. The Studio also mounts
the shared auth root and repository parent because a confirmed Launch executes
the real native runtime rather than a browser-only simulation. Git metadata for
the Luna checkout itself is mounted read-only for history/compare/restore.
Compose rejects linked worktrees explicitly: their `.git` gitfile points to an
absolute host gitdir that is unavailable under the container namespace. Use a
full clone for this deployment path.

Run `npm run build` before restarting app services after TypeScript changes so
the mounted `dist/` matches the mounted configuration.

The Compose file also mounts auth and repository state needed by real runs:

- `${LUNA_AUTH_ROOT:-./.luna/auth}` at `/app/.luna/auth` for all auth files.
- `.luna/auth/luna.auth.json` for Jira, Plane, and webhook secrets.
- `.luna/auth/pi-ai/auth.json` for Pi model auth.
- `.luna/auth/gh` for GitHub CLI auth through `GH_CONFIG_DIR`.
- `.luna/auth/ssh` for SSH repository remotes.
- `.luna/auth/git/config` for Git commit identity through
  `GIT_CONFIG_GLOBAL`.
- `${LUNA_REPOSITORIES_ROOT:-./repositories}` at `/repositories` for all
  configured repositories.

Create `.luna/auth/luna.auth.json` and `.luna/auth/git/config` before starting
Compose. For a different repository layout, either update
`config/repositories.yaml` or set `LUNA_REPOSITORIES_ROOT` to the host
directory that should appear as `/repositories`.

For local smoke tests against personal repositories, prefer ignored local
overrides over committing real repository names. A `docker-compose.override.yml`
can mount `.luna/local-config/repositories.yaml` over
`/app/config/repositories.yaml` for `webhook-server`, `webhook-worker`, and
`studio`, while `.env` sets `LUNA_REPOSITORIES_ROOT` to the host parent
directory.

The queue name and Redis URL come from `config/webhooks.yaml`, with `REDIS_URL`
available as a runtime override. Jobs use deterministic BullMQ job ids for
delivery dedupe. Worker concurrency defaults to `8` and can be overridden in
config or with `webhook-worker --concurrency <n>`.

Webhook jobs retry transient execution failures with BullMQ attempts and
exponential backoff. Permanent failures such as invalid job data or no matching
route are marked unrecoverable so they do not retry repeatedly.

Unsigned example payloads live under `examples/webhooks/`. For local smoke
tests, compute signatures with the same secret configured in
`.luna/auth/luna.auth.json`; do not disable verification.

For Plane, enable the Work items event in Plane and use
`/webhooks/plane`. The bundled config only enqueues implementation runs when the
work item is moved to `In Progress`; other activities return `200` with an
ignored result so Plane delivery retries are not triggered.

```bash
curl -X POST http://127.0.0.1:4012/webhooks/github \
  -H "content-type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: local-delivery-1" \
  -H "X-Hub-Signature-256: sha256=<computed>" \
  --data @examples/webhooks/github-pull-request-opened.json
```

```bash
curl -X POST http://127.0.0.1:4012/webhooks/plane \
  -H "content-type: application/json" \
  -H "X-Plane-Event: issue" \
  -H "X-Plane-Delivery: local-delivery-2" \
  -H "X-Plane-Signature: <computed>" \
  --data @examples/webhooks/plane-issue-state-updated.json
```

## Durability Rules

Durability matters when a workflow can pause or has external side effects.

The runtime enforces durability policy for:

- human interrupts and resume.
- workflows with external side effects.
- checkpoint backend choice.
- runtime mode.

SQLite checkpoints are the durable checkpoint backend used by the native app
configuration. Durable checkpoints allow resume to reload workflow state and
apply a human decision.

## LangGraph Workflow Runtime

The current workflow runtime id is `langgraph`.

LangGraph is used as Luna's workflow runtime adapter for stateful graph
execution, streaming events, checkpoint integration, and native interrupt
support. Luna still owns workflow YAML, capability validation, compiled nodes,
runtime state, and node execution semantics.

In code:

- `src/runtime/langgraph/workflow-graph.ts` compiles Luna nodes into a
  LangGraph graph.
- `src/runtime/langgraph/workflow-runner.ts` streams LangGraph events and maps
  native interrupts back to Luna `waiting_for_input`.
- `src/runtime/backends/sqlite/langgraph-checkpointer.ts` adapts Luna SQLite
  checkpoints for LangGraph.
- `src/runtime/workflow/runner-engine.ts` owns the generic scheduler contract
  used by LangGraph.

When SQLite checkpoints are active, Luna installs a LangGraph checkpointer and
uses synchronous durability for the stream. Without that backend, Luna still
runs the scheduler but cannot provide the same native LangGraph checkpoint
integration. Each scheduler invocation uses a disposable internal LangGraph
thread id, separate from the canonical Luna run id, so LangGraph reducers never
restore and append Luna's waiting state a second time. Internal journals are
cleaned up best-effort; Luna checkpoints remain the replay and resume authority.

The LangGraph journal is auxiliary, not Luna's run authority. Each scheduler
invocation receives a fresh internal thread id, isolated from canonical Luna
checkpoints and from later run/resume invocations; cleanup is best-effort after
the stream. This prevents append reducers from restoring canonical artifact
references a second time. Journal I/O failures are surfaced as
`runtime_durability_recovery_required`, never converted into a contradictory
failed terminal after a Luna node completion or human wait is already durable.

A compiled node that can create a pending interrupt must be dependency-ordered
with every other workflow node. Independent HITL siblings are rejected at
compile time, so a durable waiting result cannot race with and hide a failure
from another branch. Luna may relax this restriction only after it has an
explicit durable model for mixed parallel wait/failure outcomes.

## Pi Agent Runtime

The current agent runtime id is `pi`.

The installed `@earendil-works/pi-ai` package describes itself as a unified LLM
API with model discovery, provider configuration, token/cost tracking, tool
calling, context persistence, and provider handoff support. Luna uses it
through `src/agent-runtimes/pi/**`.

The Pi adapter owns:

- translating Luna model profiles into Pi model options.
- loading Pi auth.
- creating model sessions.
- materializing Luna local tools as Pi tools.
- converting tool ids to model-safe names.
- validating tool arguments.
- running tool-call loops.
- parsing final JSON output.
- bridging usage/log details to Luna observability.

Current support advertised by the Luna Pi adapter:

- tool protocols: `local`.
- runtime requirements: `tool_calling`.

MCP policy can be configured and resolved, but Pi does not currently
materialize MCP tools. A workflow or agent that requires MCP tools will fail
runtime requirement validation with Pi.

## Runtime State

Runtime state is checkpoint-safe JSON plus runtime context.

Checkpointed state includes:

- invocation.
- flattened runtime config.
- run identity.
- workflow metadata.
- previous `steps`.
- artifact refs.
- lifecycle evidence.

Runtime-only context includes operational objects such as repository/workspace
roots, executors, ports, artifact publishers, observability, and abort signals.
Expressions can see selected context roots, but those objects are not serialized
directly into checkpoints.

After final output validation, terminalization has one authority. Ordinary CLI
runs commit the exact succeeded checkpoint. A control plane may instead install
a terminal durability barrier; Luna resolves that durable intent first and
treats the runtime checkpoint as a secondary projection. This prevents a
checkpoint from claiming success while control-plane recovery claims failure.

Studio lease acquisitions use a fresh cryptographic token in mutable heartbeat
and terminal transition ids. Reacquiring a run with the same logical owner cannot
reuse ids merely because an in-memory sequence counter restarted; content-derived
recovery claims and outcome proofs stay deterministic where replay idempotency is
required.

Resume migrates a legacy run that predates execution-identity checkpoints only
after a read-only preflight validates its exact waiting checkpoint and matching
interrupt against the compiled workflow revision and persisted resume context.
Invalid resume input cannot create the identity checkpoint or bind the run to a
newer definition.

Terminalization never performs destructive workspace cleanup. Luna retains the
workspace after both success and failure, for CLI and control-plane runs, so
that terminal authority, returned state, and physical path cannot diverge. The
`workspace.preserve_on_success` and `workspace.preserve_on_failure` fields are
required retention assertions and only accept `true`; `false` is rejected as
invalid configuration rather than being silently ignored.

A future cleanup command needs its own durable intent,
`pending/completed/unknown` reconciliation, confirmation policy, idempotent
postcondition checks, and observable result. Until that separately planned
operation exists, neither the runtime nor Studio deletes a run worktree during
terminalization or recovery.

## Events

Luna emits workflow events to the runtime event store and writes mandatory
`events.jsonl` in the run artifact directory.

Events are append-only evidence for:

- run start/success/failure/waiting.
- node scheduling and completion.
- runtime stream projection.
- interrupts.
- artifact publication.

Use events for audit and debugging. Use final reports for user-facing summary.

## Observability

Observability is built from telemetry records and sinks.

Every run creates a workflow observability recorder with:

- an in-memory buffer.
- a JSONL trace sink.
- optional runtime-log projection sink.

Telemetry records include spans, span events, and logs. The runner wraps the
workflow in a `workflow.run` span and node execution emits node-level
observability. At close, Luna writes `observability-summary.json` best-effort
through the artifact publisher.

`runtime_log` is an optional projection. It converts telemetry into compact log
entries with timestamp, level, message, and optional node id. `events.jsonl` is
mandatory and should not be disabled through workflow YAML.

When the artifact backend is filesystem, runtime composition adds a required
`trace.jsonl` sink under the run directory. Required sink failures can fail the
run. Optional sink failures are isolated so observability integrations do not
hide the actual workflow result.

The codebase also provides LangSmith and OpenTelemetry trace sink bridges in
`src/core/observability/exporters.ts`. They are extension points for native
platform/plugin wiring; the default app config does not require external trace
services.

## Artifacts And Logs

Default native runs write under:

```text
.runs/<workflow-id>/<run-id>/
```

Typical files:

- `invocation.json`
- `run.json`
- `events.jsonl`
- `trace.jsonl`
- `observability-summary.json`
- planned node artifacts
- final reports
- interrupt records when waiting for input
- backend runtime logs when enabled

Large `local-exec` output can be written to local-exec artifacts rather than
embedded directly into node output.

## Resume

Resume is a runtime operation, not a new workflow.

```bash
npm run dev -- resume \
  --target workflow:implementation \
  --thread <run-id> \
  --checkpoint <checkpoint-id> \
  --interrupt <interrupt-id> \
  --decision '{"approved":true}'
```

The native runner reloads app/repository config, reloads and recompiles the
workflow definition, loads the checkpoint, reconstructs run/invocation context,
authorizes resume, applies the decision, and continues execution.

Before returning `waiting_for_input`, Luna completes a deterministic wait
protocol for that run and gate:

1. persist an `interrupt_wait_intent` with the stable checkpoint/interrupt ids,
   workflow revision, resume context, timestamp, pre-gate artifact refs, and
   prior interrupt refs;
2. persist the prior step writes and the exact waiting checkpoint;
3. create the interrupt with create-if-absent exact semantics;
4. persist `interrupt_wait_completion` only after the other three stages are
   durable.

Every stage is reconciled against the same run/node identity. An exact record
already present is adopted; conflicting durable state is rejected. If a store
may have committed but its exact read-back is temporarily unavailable, Luna
returns `runtime_checkpoint_write_acceptance_unknown` or
`runtime_durability_recovery_required`. These codes mean the outcome is
inconclusive and must be replayed with the same run identity. They do not write a
failed terminal checkpoint or a false `run.failed`/`node.failed` event. On that
replay, durable completed nodes before the gate are rehydrated rather than
executed again, and the wait protocol advances to its exact completion marker.
After that completion marker exists, a late LangGraph stream or auxiliary
checkpointer failure returns the authoritative `waiting_for_input` result; it
cannot create a failed terminal. Auxiliary journal failures after an ordinary
node completion instead return `runtime_durability_recovery_required`, allowing
an exact replay to adopt the node completion without rerunning its executor.
Checkpoint-write access failures while loading a wait intent, resume writes, or
persisted node recovery receive the same non-terminal classification; semantic
validation of successfully read records remains a deterministic state error.

The waiting checkpoint appends the current interrupt ref to the prior history
with exact deduplication. Resume validates and rehydrates that collection, so
sequential gates retain `[A]`, then `[A, B]`, and the final state/terminal
projection still carries `[A, B]` for audit provenance.

After authorization, the interrupt store atomically resolves the exact resume
input. Applying the decision to workflow state uses a durable step write, while
the `resume_completion` marker is written only after the resumed node output and
all required artifacts are durable. A retry that finds only the decision repeats
artifact publication; a retry that finds the exact completion marker restores
its artifact references without republishing. A commit-then-throw response is
accepted only when exact read-back returns the same deterministic record.

Authorization and expiration are evaluated before the first `pending` to
`resuming` claim. If the process stops after that claim, an exact retry adopts
its persisted resume attempt and input without re-evaluating policies that may
have changed meanwhile; this lets the already-authorized transition finish.
A different decision, actor, or payload remains `interrupt_conflict`, and an
incomplete claim fails closed for operator recovery.

Normal nodes use the same rule: a `steps` write proves only that executor output
is durable. A separate `node_completion` marker, bound to that output digest, is
written after every declared artifact succeeds. Resume rehydrates artifact refs
from exact markers, skips completed nodes without re-entering their executors,
and can finish an output-only node by retrying its artifact batch. Pre-gate
artifact refs are also retained in the waiting checkpoint.

Fresh execution and resume application share one run-scoped lease through
terminalization, so two callers for the same run cannot advance nodes
concurrently.
Before a fresh run or resume performs recovery or executes a node, Luna loads
and validates both possible terminal checkpoint identities. Any exact succeeded
or failed terminal rejects the replay because its ref-only snapshot cannot
reconstruct the complete workflow output. If both terminal identities exist,
Luna reports `runtime_checkpoint_schema_mismatch` as an integrity violation.
A durable gate marker never bypasses the
workflow success checkpoint/control-plane barrier; that barrier is attempted
again until it establishes the success authority.

Filesystem lease recovery is fail-closed. A stale heartbeat alone never proves
that a holder is dead. Luna recovers a live PID only when a strong Linux procfs
identity proves PID reuse; when that identity is unavailable (including other
operating systems), a live PID remains non-recoverable regardless of lock age.
This may require operator cleanup after PID reuse, but it cannot create two live
resume holders that execute downstream effects concurrently.

## Failure Model

Failures are surfaced with structured runtime errors where possible.

Common failure classes:

- invalid workflow definition.
- unsupported runtime/backend id.
- unsupported agent runtime requirement.
- missing durable checkpoint.
- schema-invalid node output.
- artifact publication failure.
- validation command failure.
- side-effect policy mismatch.
- provider auth/config/API error.

When a parallel LangGraph batch produces nested `AggregateError` values, Luna
recursively extracts every node-attempt failure, orders the primary cause by
stable node identity, and merges all failed lifecycles with completed sibling
state before terminal projection. Partial artifact refs and completed sibling
steps are therefore not lost merely because another branch failed first.

`runtime_checkpoint_write_acceptance_unknown` and
`runtime_durability_recovery_required` are deliberately not terminal failure
classifications. They require exact reconciliation with the same durable
identity; converting either one into a failed run could contradict a write that
already committed.

The runtime binds a `run_id` to the compiled workflow id and revision in an exact
checkpoint before it executes the first node. Persisted node output/completion
ids include a digest of the same identity. Retrying that exact revision can reuse
durable work; presenting the same `run_id` with another workflow or revision is a
state conflict raised before node execution. Native workflow revision loading
includes referenced agent definition digests, so changing an agent cannot inherit
the prior node completion marker.

Studio adds a stricter control-plane rule for uncertain external effects: once a
write-capable dispatch has started, missing terminal proof becomes
`outcome_unknown` and is never replayed automatically. Only a preflight-proven
read-only job with an exact durable recovery intent may be requeued. This does not
change the generic checkpoint acceptance rule above; it narrows Studio dispatch
recovery where an external side effect could already have happened.

If an ordinary runtime failure cannot be committed and read back as the exact
failed terminal checkpoint, Luna returns
`runtime_durability_recovery_required`. It does not emit `run.failed` or call the
failed-state terminal observer, because either projection would falsely invite a
resume that might repeat an external effect. Studio maps that uncertainty to its
manual-reconciliation outcome instead of replaying the run.

The run artifacts and events should contain enough evidence to inspect what
failed and where.

## Source Map

- Native platform loader: `src/platform/native/native-platform-loader.ts`
- Native plugin definitions: `src/platform/native/native-platform-plugins.ts`
- Native workflow runner: `src/platform/native/native-workflow-runner.ts`
- Native run context: `src/platform/native/native-run-context.ts`
- Runtime composition: `src/runtime/composition/runtime-composition.ts`
- App runtime config parsing: `src/runtime/composition/app-config.ts`
- Durability policy: `src/runtime/composition/durability.ts`
- LangGraph runner: `src/runtime/langgraph/workflow-runner.ts`
- Generic runner engine: `src/runtime/workflow/runner-engine.ts`
- Node runner: `src/runtime/workflow/node-runner.ts`
- Checkpoint exact-write protocol: `src/runtime/workflow/checkpoints.ts`
- Human-wait protocol: `src/runtime/workflow/interrupts.ts`
- Persisted node recovery: `src/runtime/workflow/persisted-node-recovery.ts`
- Resume application: `src/runtime/workflow/resume-application.ts`
- Observability recorder: `src/core/observability/tracing.ts`
- Observability sinks: `src/core/observability/sinks.ts`
- Summary projection: `src/core/observability/summary-projection.ts`
- Pi adapter: `src/agent-runtimes/pi/adapter.ts`
- Pi factory: `src/agent-runtimes/pi/factory.ts`
- Pi auth: `src/agent-runtimes/pi/auth.ts`
