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
- change-request provider factories.
- capability manifests.

Bundled plugins currently wire:

- `runtime`: Pi agent runtime and LangGraph workflow runtime.
- `quality-gates`: gated-agent-loop pattern executors.
- `github`: GitHub PR adapter, preflight hook, GitHub change requests.
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

The queue name and Redis URL come from `config/webhooks.yaml`, with `REDIS_URL`
available as a runtime override. Jobs use deterministic BullMQ job ids for
delivery dedupe. Worker concurrency defaults to `8` and can be overridden in
config or with `webhook-worker --concurrency <n>`.

Webhook jobs retry transient execution failures with BullMQ attempts and
exponential backoff. Permanent failures such as invalid job data or no matching
route are marked unrecoverable so they do not retry repeatedly.

Unsigned example payloads live under `examples/webhooks/`. For local smoke
tests, compute signatures with the same secret configured in `luna.auth.json`;
do not disable verification.

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
  --data @examples/webhooks/plane-issue-create.json
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
integration.

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
- Resume application: `src/runtime/workflow/resume-application.ts`
- Observability recorder: `src/core/observability/tracing.ts`
- Observability sinks: `src/core/observability/sinks.ts`
- Summary projection: `src/core/observability/summary-projection.ts`
- Pi adapter: `src/agent-runtimes/pi/adapter.ts`
- Pi factory: `src/agent-runtimes/pi/factory.ts`
- Pi auth: `src/agent-runtimes/pi/auth.ts`
