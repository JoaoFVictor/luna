# Luna Agent Guide

Use this file as the first orientation point for agents working in this
repository.

## Project Shape

Luna is a multi-agent workflow orchestration repo built around generic YAML
workflows. It has one generic workflow entrypoint in `src/workflows/luna.ts`;
do not add a TypeScript workflow file per workflow.

Runtime flow:

```text
adapter -> invocation -> deterministic router -> YAML workflow graph -> runtime composition -> built-ins/agents/gated_agent_loop -> artifacts
```

Primary extension points:

- `agents/<id>/`: reusable Luna agent definitions.
- `workflows/<id>/`: YAML workflow graphs.
- `src/adapters/<id>/`: input adapters for external sources.
- `src/core/built-ins/`: deterministic workflow built-ins.
- `src/core/context/`: deterministic repository/agent context intake.
- `src/core/workflow/`: runtime-neutral workflow contracts, validation,
  execution policy, graph loading, and orchestration mechanics.
- `src/providers/<provider>/`: provider-owned SDK/API integrations, auth,
  schemas, payload mapping, provider reports, provider built-ins, and
  change-request services.
- `src/core/tools/`: Luna-native local tool contracts and catalog.
- `src/agent-runtimes/<runtime>/`: concrete agent runtime adapters, including
  runner, capabilities, tool/MCP materialization, model options, auth bridges,
  and observability.
- `src/core/agent-runtime/flue/**`: legacy Flue adapter code that may remain
  only until the Task 18 atomic cutover; do not add new runtime guidance that
  treats this as the target location.
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
- `skills/implementation-safe-git/SKILL.md`: safe file/git discipline for
  trusted local write agents and implementation loops.

## Non-Negotiables

- Keep routing deterministic. Do not ask an LLM which workflow to run.
- Do not add workflow-specific CLI commands; use `run --target workflow:<id>`.
- Do not create compatibility wrappers or deadcode for old architecture.
- Keep agents reusable; put orchestration in workflow YAML nodes.
- Use `quality-gates.gated_agent_loop` pattern nodes for trusted local write
  loops. Gates are configured in `workflows/<id>/workflow.yaml` under the
  pattern node's `gates:` list. Current gate types are
  `quality-gates.validation_commands` and `quality-gates.agent_review`. For an
  agent-review gate, configure JSONata `block_when.expression`, optional
  `feedback.expression`, and `input.review_agent` on the workflow gate entry,
  never in `agents/<id>/agent.yaml`; failed gates loop back to the writer as
  repair input. Keep gate policy provider-agnostic.
- Keep module responsibilities isolated. Generic modules must stay agnostic:
  `src/core/built-ins/`, `src/core/tools/`, `src/core/context/`,
  `src/core/workflow/`, runtime-neutral core contracts, and shared helpers
  must not know provider-specific auth, config, schemas, URLs, payload shapes,
  repository details, runtime SDKs, or workflow-specific behavior.
- Keep provider responsibilities isolated. Provider-specific code belongs under
  `src/providers/<provider>/`. Do not add provider SDK, schema, auth, payload,
  report, or change-request code under `src/core/providers/**`. A provider
  module must never import, validate, store, or mention another provider's
  schema/auth/config. Shared provider helpers may only handle neutral mechanics,
  such as reading `luna.auth.json` as unknown provider data.
- Keep composition at composition roots. Cross-provider or generic-plus-provider
  wiring belongs in explicit registries/factories such as
  `src/adapters/registry.ts`, provider capability registries, or runtime
  factories, not in leaf modules.
- Put context files in repository or agent config; collect them through
  `collect_context` and pass `context: { expression: "$.steps.context" }`
  explicitly so Luna can render them as runtime instructions with
  `context_audit` task metadata.
- Keep skills explicit and layered. Repository skills live in
  `config/repositories.yaml` and resolve relative to the prepared repository
  root. Agent skills live in `agents/<id>/agent.yaml` and resolve relative to
  the agent directory. Luna loads repository skills first, then agent skills;
  do not mix skill loading into context intake or provider adapters.
- Keep runtime-neutral built-ins and shared catalog helpers under
  `src/core/built-ins/`; provider-owned built-ins belong under
  `src/providers/<provider>/` and are wired through composition roots.
- Register local tools through `src/core/tools/catalog.ts`; runtime-specific
  materialization belongs under `src/agent-runtimes/<runtime>/`.
- During the Luna LangGraph rebuild, keep AGENTS.md and Luna skills aligned
  with target architecture. Broad README/example updates are deferred to the
  durable docs task.
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
