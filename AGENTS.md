# Luna Agent Guide

Use this file as the first orientation point for agents working in this
repository.

## Project Shape

Luna is a local-first multi-agent orchestration repo built on Flue. It has one
generic workflow entrypoint in `src/workflows/luna.ts`; do not add a TypeScript
workflow file per workflow.

Runtime flow:

```text
adapter -> invocation -> router -> workflow graph -> built-ins/agents/agent loops -> artifacts
```

Primary extension points:

- `agents/<id>/`: reusable Flue agent definitions.
- `workflows/<id>/`: YAML workflow graphs.
- `src/adapters/<id>/`: input adapters for external sources.
- `src/core/built-ins/`: deterministic workflow built-ins.
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
- Register built-ins through `src/core/built-ins/catalog.ts`.
- Register local tools through `src/core/tools/catalog.ts`; Flue
  materialization lives in `src/core/agent-runtime/flue/tool-registry.ts`.
- Update README/examples when adding public extension points.
- Run focused tests for the touched area plus `npm run typecheck`.

## Useful Docs

- `README.md`
- `examples/configured-workflows.md`
- `examples/new-agent.md`
- `examples/new-workflow.md`
- `examples/new-adapter.md`
- `examples/new-built-in.md`
- `examples/new-tool.md`
