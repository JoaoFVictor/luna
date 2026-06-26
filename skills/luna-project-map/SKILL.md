---
name: luna-project-map
description: Use when first working in Luna, orienting to its architecture, deciding where a change belongs, or explaining adapters, workflows, agents, built-ins, tools, MCP, subagents, artifacts, and runtime flow.
---

# Luna Project Map

Luna is a multi-agent workflow orchestration repo built around generic YAML
workflows, runtime-neutral core contracts, provider-owned integrations, and
concrete agent runtimes. Start with `AGENTS.md`.

Runtime flow:

```text
adapter -> invocation -> deterministic router -> YAML workflow graph -> runtime composition -> built-ins/agents/gated_agent_loop -> artifacts
```

## Extension Points

| Need | Location | Guide |
| --- | --- | --- |
| External input source | `src/adapters/<id>/` | `examples/new-adapter.md` |
| Reusable worker | `agents/<id>/` | `examples/new-agent.md` |
| Orchestration shape | `workflows/<id>/` | `examples/new-workflow.md` |
| Deterministic workflow action | `src/core/built-ins/` | `examples/new-built-in.md` |
| Workflow core contracts | `src/core/workflow/` | Runtime-neutral graph, validation, and execution policy |
| Provider-owned integration | `src/providers/<provider>/` | Provider SDK/API, auth, schema, payload, report, built-ins, and change-request code |
| Repository/agent context intake | `src/core/context/` + `collect_context` | `examples/new-agent.md`, `examples/new-workflow.md` |
| Write-mode git/workspace services | `src/core/write-mode/` | `skills/luna-create-built-in/SKILL.md` |
| Agent-local callable function | `src/core/tools/` + `src/core/tools/catalog.ts` | `examples/new-tool.md` |
| Concrete agent runtime adapter | `src/agent-runtimes/<runtime>/` | Runtime runner, tool materialization, model projection, auth bridge, observability bridge |
| Native Pi agent runtime | `src/agent-runtimes/pi/**` | Current concrete model runtime |
| LLM/runtime guidance | `skills/<id>/SKILL.md` | existing skills |

## Boundaries

- Adapter: normalize external input into an invocation. Never run workflows.
- Router: choose workflow deterministically from target/routing config.
- Workflow: order built-ins, agents, and gated agent loops.
- Agent: perform model judgment with a schema output.
- Context intake: read configured repository and agent files deterministically
  and emit `context-intake.json`.
- Built-in: deterministic TypeScript node called by YAML.
- Write mode: deterministic git/worktree lifecycle services used by
  implementation built-ins.
- Tool: deterministic function exposed to an agent.
- Skill: instructions loaded by an LLM or configured runtime agent.
- Runtime adapter: runtime-specific materialization for agents, tools, MCP,
  model options, observability sinks, and workflow launch composition.

## Provider Isolation

Provider-specific code must stay in its own lane under `src/providers/`. Do
not put Plane behavior, schemas, auth, config, fixtures, or tests inside Jira
modules, and do not put Jira behavior inside Plane modules. The same rule
applies to every provider pair.

Shared provider helpers are allowed only when they are truly provider-agnostic.
They may read `luna.auth.json` as unknown provider data, but must not validate
or mention Jira, Plane, GitHub, or any other provider-specific credential
shape. Provider-specific validation belongs under that provider's directory in
`src/providers/`.

Adapters for external providers are provider-owned boundaries. They may import
neutral core contracts and their own provider helper modules, but must not
reach into another provider's directory.

## Architecture Rules

- Do not add `src/workflows/<workflow>.ts`; use the generic `luna` entrypoint.
- Do not add workflow-specific CLI commands.
- Do not create handwritten built-in name lists outside the active built-in
  registry and metadata map.
- Do not register local tools outside `src/core/tools/catalog.ts`.
- Do not keep compatibility wrappers or deadcode.
- Do not put Pi-specific implementation files under provider-neutral modules.
- Do not add provider SDK, schema, auth, payload, report, or change-request code
  under `src/core/**`; use `src/providers/<provider>/`.
- Do not add built-in barrel exports.

## Verification

Run focused tests for the changed area, `npm run typecheck`,
`npm run typecheck:unused-src`, and `npm run lint:unused`. Before
finishing a broad change, run `npm test` and `npm run build`.
