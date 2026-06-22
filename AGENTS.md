# Luna Agent Guide

Use this file as the first orientation point for agents working in this
repository.

## Project Shape

Luna is a multi-agent workflow orchestration repo with Flue as the current
agent runtime adapter. It has one generic workflow entrypoint in
`src/workflows/luna.ts`; do not add a TypeScript workflow file per workflow.

Runtime flow:

```text
adapter -> invocation -> router -> workflow graph -> built-ins/agents/gated_agent_loop -> artifacts
```

Primary extension points:

- `agents/<id>/`: reusable Luna agent definitions.
- `workflows/<id>/`: YAML workflow graphs.
- `src/adapters/<id>/`: input adapters for external sources.
- `src/core/built-ins/`: deterministic workflow built-ins.
- `src/core/context/`: deterministic repository/agent context intake.
- `src/core/providers/<id>/`: provider-specific integrations and adapters to
  provider APIs, auth, config, reports, built-ins, and change-request services.
- `src/core/tools/`: Luna-native local tool contracts and catalog.
- `skills/`: reusable guidance for LLMs and runtime agents.

## Use The Luna Skills

Before changing an area, read the matching project skill:

- `skills/luna-project-map/SKILL.md`: repo orientation and architecture.
- `skills/luna-create-agent/SKILL.md`: create or modify agents.
- `skills/luna-create-workflow/SKILL.md`: create or modify workflow YAML.
- `skills/luna-create-adapter/SKILL.md`: create input adapters.
- `skills/luna-create-built-in/SKILL.md`: create workflow built-ins.
- `skills/luna-create-tool/SKILL.md`: create local Luna tools.
- `skills/luna-review-change/SKILL.md`: review Luna changes critically.

## Non-Negotiables

- Keep routing deterministic. Do not ask an LLM which workflow to run.
- Do not add workflow-specific CLI commands; use `run --target workflow:<id>`.
- Do not create compatibility wrappers or deadcode for old architecture.
- Keep agents reusable; put orchestration in workflow graphs.
- Use `gated_agent_loop` for trusted local write loops. Gates are configured in
  `workflows/<id>/graph.yaml` under the node's `gates:` list. Current gate
  types are `validation_commands` and read-only workflow `agent` gates. For an
  `agent` gate, configure JSONata `block_when.expression` and optional
  `feedback.expression` on the workflow gate entry, never in
  `agents/<id>/agent.yaml`; failed gates loop back to the writer as repair
  input. Keep gate policy provider-agnostic.
- Keep module responsibilities isolated. Generic modules must stay agnostic:
  `src/core/built-ins/`, `src/core/tools/`, `src/core/context/`,
  `src/core/workflow/`, and shared helpers must not know provider-specific
  auth, config, schemas, URLs, payload shapes, or workflow details.
- Keep provider responsibilities isolated. Provider-specific code belongs under
  `src/core/providers/<provider>/` or the matching provider-owned adapter.
  A provider module must never import, validate, store, or mention another
  provider's schema/auth/config. Shared provider helpers may only handle neutral
  mechanics, such as reading `luna.auth.json` as unknown provider data.
- Keep composition at composition roots. Cross-provider or generic-plus-provider
  wiring belongs in explicit registries/factories such as
  `src/adapters/registry.ts`, `src/core/providers/built-ins.ts`, or runtime
  factories, not in leaf modules.
- Put context files in repository or agent config; collect them through
  `collect_context` and pass `context: $.steps.context` explicitly so Luna can
  render them as runtime instructions with `context_audit` task metadata.
- Register provider-facing built-ins through `src/core/providers/built-ins.ts`;
  keep runtime-neutral built-ins and shared catalog helpers under
  `src/core/built-ins/`.
- Register local tools through `src/core/tools/catalog.ts`; Flue
  materialization lives in `src/core/agent-runtime/flue/tool-registry.ts`.
- Update README/examples when adding public extension points.
- Run focused tests for the touched area plus `npm run typecheck`,
  `npm run typecheck:unused-src`, and `npm run lint:unused`.

## Useful Docs

- `README.md`
- `examples/configured-workflows.md`
- `examples/new-agent.md`
- `examples/new-workflow.md`
- `examples/new-adapter.md`
- `examples/new-built-in.md`
- `examples/new-tool.md`
