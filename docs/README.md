# Luna Architecture

These docs describe the code that exists now, not an idealized version of the
project. Use them when changing Luna internals or adding public authoring
surfaces.

```text
CLI / input adapter
  -> Invocation
  -> deterministic router
  -> workflow YAML definition
  -> native platform registrations
  -> runtime composition
  -> scheduler + node executors
  -> artifacts, events, checkpoints, reports
```

## Read First

- [Workflows and artifacts](workflows-and-artifacts.md)
- [Workflow runtime config](workflow-runtime-config.md)
- [Agents, context, and skills](agents-context-and-skills.md)
- [Adapters and providers](adapters-and-providers.md)
- [Capabilities, tools, and runtime](built-ins-tools-and-runtime.md)
- [Capabilities reference](capabilities-reference.md)
- [Runtime and observability](runtime-and-observability.md)
- [Configuration reference](configuration-reference.md)
- [Luna Studio operational guide](studio-guide.md)

## Luna Studio

The Studio is the implemented local control plane for workflow and agent
authoring, isolated agent smoke tests, classified workflow configuration,
deterministic launch, run inspection, and Git-backed restore-as-draft:

- [Operational guide and current limits](studio-guide.md)
- [Architecture decisions](studio-architecture.md)

Recipes live in `examples/`. Agent-facing operating rules live in `skills/`.

## Layer Map

| Layer | Code | Owns |
| --- | --- | --- |
| CLI | `src/cli.ts` | command parsing, adapter invocation loading, routing, target execution |
| Generic workflow entrypoint | `src/workflows/luna.ts` | loading the native platform and delegating to `runWorkflow` |
| Native platform | `src/platform/native/**` | plugin registrations, platform loading, native run context, executor wiring |
| Router | `src/core/router/**` | strict invocation envelope and deterministic JSONata route selection |
| Workflow definition | `src/core/workflow/**` | YAML parsing, capability validation, DAG analysis, compilation contracts |
| Runtime scheduler | `src/runtime/workflow/**` | node scheduling, resume, checkpoints, final output, node execution |
| LangGraph adapter | `src/runtime/langgraph/**` | current workflow runtime adapter over generic scheduler contracts |
| Runtime composition | `src/runtime/composition/**` | backend selection, agent/workflow runtime factories, ports, observability |
| Observability | `src/core/observability/**` | spans, logs, sinks, runtime-log projection, summary artifacts |
| Capabilities | `src/capabilities/**` | manifests, built-ins, patterns, gates, tools, ports, policies |
| Providers | `src/providers/**` | source-system adapters, auth/config, payload parsing, reports, PR review and change-request publishing |
| Agents | `agents/<id>/` and `src/capabilities/agents/**` | reusable model roles and agent-node execution contracts |
| Agent runtimes | `src/agent-runtimes/<runtime>/` | runtime-specific model/tool/materialization logic |
| Studio server | `src/studio/**` | DTO-only local Control API, drafts, validation, apply recovery, configuration, launch, run ledger, history, logs, graphs, and artifacts |
| Studio browser | `apps/studio/src/**` | React authoring and operating surfaces over the Control API |

## Extension Decision Guide

Use `workflows/<id>/` when orchestration changes: node order, dependencies,
gates, artifacts, mode, required capabilities, or final reporting shape.
Workflow-owned runtime settings are also declared there with `config.file` and
`config.schema`; the runtime loads the matching file from `config/` and exposes
validated data as `$.config`. See
[Workflow runtime config](workflow-runtime-config.md) for the full contract.

Use `agents/<id>/` when a reusable model role changes: instructions, output
schema, model profile, tools, MCP servers, skills, context, or subagents.

Use `src/capabilities/<capability>/` when adding a public deterministic
operation, pattern, gate, local tool, port, policy, or artifact publisher.
Register public ids through the capability manifest and official registry.

Use `src/providers/<provider>/` when behavior depends on source-system auth,
config, URLs, API payloads, task context, report rendering, or change-request
publishing. This includes provider-specific implementations of
provider-neutral ports such as pull request review publication.

Use native platform plugin registration when wiring adapters, provider
built-ins, runtime factories, pattern executors, or provider-backed publishing
providers into the running platform.

Use `src/agent-runtimes/pi/**` only for Pi-specific materialization:
model calls, Pi tool conversion, runtime auth, usage/log bridging, and Pi
capability support.

Use `src/core/observability/**` when changing telemetry record shape, sinks,
summary projection, or external trace bridge contracts.

## Non-Negotiables

- Routing is deterministic. Do not ask a model which workflow to run.
- Do not add workflow-specific CLI commands.
- Do not add per-workflow TypeScript entrypoints.
- Keep provider code provider-owned. Generic core/capability modules must not
  import provider auth, schema, URL, SDK, or payload details.
- Keep runtime-specific code at runtime boundaries.
- Keep orchestration in workflow YAML, not inside agent prompts.
- Keep context explicit through `context.collect_context`.
- Treat capability manifests as the public registry, not scattered name lists.
- Side-effecting built-ins must declare and use side-effect policies.
- Agents should not commit, push, or create change requests; deterministic
  built-ins own publishing gates.
- Do not add workflow-specific runtime config branches. Put the schema under
  `workflows/<id>/config.schema.json`, the values under `config/<file>.yaml`,
  and pass values into nodes through workflow expressions.

## Verification

For broad documentation or architecture changes, run:

```bash
npm test
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
npm run build
```

For scoped code changes, run focused tests for the touched layer plus the
type/unused/lint checks.
