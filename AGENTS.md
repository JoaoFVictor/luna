# Luna Agent Guide

Use this file as the first orientation point for agents working in this
repository.

## Project Shape

Luna is a deterministic multi-agent workflow orchestration repo. It runs
generic YAML workflows through a native platform/runtime composition layer.

```text
input adapter or invocation JSON
  -> deterministic router
  -> workflows/<id>/workflow.yaml
  -> native platform registrations
  -> runtime scheduler
  -> capability built-ins / agents / patterns / gates
  -> artifacts
```

There is one generic TypeScript workflow entrypoint:
`src/workflows/luna.ts`. Do not add one TypeScript workflow file per workflow.

## Current Extension Points

- `workflows/<id>/`: strict YAML workflow graphs plus JSON schemas.
- `agents/<id>/`: reusable model roles and output contracts.
- `src/capabilities/<capability>/`: capability manifests and deterministic
  built-ins, patterns, gates, tools, ports, policies, and publishers.
- `src/providers/<provider>/`: provider-owned input adapters, auth/config,
  payload parsing, task/PR context, reports, and change-request actions.
- `src/platform/native/**`: native plugin registration and workflow execution
  wiring.
- `src/runtime/**`: runtime backend composition, LangGraph adapter,
  scheduler, checkpoints, interrupts, event logs, runtime logs, and artifacts.
- `src/core/observability/**`: telemetry, spans, sinks, runtime-log
  projection, external trace bridges, and summary artifacts.
- `src/core/**`: runtime-neutral contracts, validation, security, config,
  routing, workflow definition/compilation, JSON/runtime state, observability,
  and shared helpers.
- `src/agent-runtimes/pi/**`: Pi-specific agent runtime adapter.
- `skills/`: reusable guidance for humans and runtime agents.

## Use The Luna Skills

Before changing an area, read the matching project skill:

- `skills/luna-project-map/SKILL.md`: repo orientation and boundaries.
- `skills/luna-create-workflow/SKILL.md`: create or modify workflow YAML.
- `skills/luna-create-agent/SKILL.md`: create or modify agents.
- `skills/luna-create-adapter/SKILL.md`: create provider-owned input adapters.
- `skills/luna-create-built-in/SKILL.md`: create capability built-ins.
- `skills/luna-create-tool/SKILL.md`: create local tools for agents.
- `skills/luna-review-change/SKILL.md`: review Luna changes critically.
- `skills/implementation-safe-git/SKILL.md`: safe file/git discipline.

## Non-Negotiables

- Keep routing deterministic. Do not ask an LLM which workflow to run.
- Do not add workflow-specific CLI commands; use `run --target workflow:<id>`,
  `--from <adapter>`, or `--input <invocation.json>`.
- Do not add `src/workflows/<workflow>.ts`; add `workflows/<id>/`.
- Do not create unregistered indirection or unused code.
- Keep agents reusable. Workflow YAML owns orchestration, dependencies, gates,
  retries, and artifact plans.
- Use capability manifests as the public registry for built-ins, patterns,
  gates, tools, ports, policies, and publishers. Avoid duplicate hand-written
  public id lists.
- `quality-gates.gated_agent_loop` gates are configured on the pattern node in
  workflow YAML. Gate policy does not belong in `agents/<id>/agent.yaml`.
- Side-effecting built-ins must declare explicit workflow `policies:` matching
  their capability side-effect policy.
- Context is explicit. Run `context.collect_context` and pass
  `context: { expression: "$.steps.context" }` to model nodes that need it.
- Skills are explicit runtime guidance. Repository skills live in
  `config/repositories.yaml`; agent skills live in `agents/<id>/agent.yaml`.
- Provider-specific auth, config, schemas, URLs, payloads, task context,
  reports, and publishing belong under `src/providers/<provider>/`.
- Generic `src/core/**` and provider-neutral capabilities must not know
  provider-specific data shapes or runtime SDK details.
- Pi-specific code belongs under `src/agent-runtimes/pi/**`.
- Agents in trusted write loops edit worktrees. They do not commit, push, or
  create change requests; deterministic built-ins own those gates.
- Run focused tests for the touched area plus `npm run typecheck`,
  `npm run typecheck:unused-src`, and `npm run lint:unused`.

## Useful Docs

- `README.md`
- `docs/README.md`
- `docs/workflows-and-artifacts.md`
- `docs/agents-context-and-skills.md`
- `docs/adapters-and-providers.md`
- `docs/built-ins-tools-and-runtime.md`
- `docs/capabilities-reference.md`
- `docs/runtime-and-observability.md`
- `docs/configuration-reference.md`
- `examples/README.md`
