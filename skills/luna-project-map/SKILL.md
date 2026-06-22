---
name: luna-project-map
description: Use when first working in Luna, orienting to its architecture, deciding where a change belongs, or explaining adapters, workflows, agents, built-ins, tools, MCP, subagents, artifacts, and runtime flow.
---

# Luna Project Map

Luna is a multi-agent workflow orchestration repo with Flue as the current
agent runtime adapter. Start by reading `README.md` and
`examples/configured-workflows.md`.

Runtime flow:

```text
adapter -> invocation -> router -> workflow graph -> built-ins/agents/gated_agent_loop -> artifacts
```

## Extension Points

| Need | Location | Guide |
| --- | --- | --- |
| External input source | `src/adapters/<id>/` | `examples/new-adapter.md` |
| Reusable worker | `agents/<id>/` | `examples/new-agent.md` |
| Orchestration shape | `workflows/<id>/` | `examples/new-workflow.md` |
| Deterministic workflow action | `src/core/built-ins/` | `examples/new-built-in.md` |
| Repository/agent context intake | `src/core/context/` + `collect_context` | `examples/new-agent.md`, `examples/new-workflow.md` |
| Write-mode git/workspace services | `src/core/write-mode/` | `skills/luna-create-built-in/SKILL.md` |
| Agent-local callable function | `src/core/tools/` + `src/core/tools/catalog.ts` | `examples/new-tool.md` |
| Current agent runtime adapter | `src/core/agent-runtime/flue/` | Flue runner, capabilities, CLI launch, model projection, Pi auth, observability bridge |
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
- Runtime adapter: provider-specific materialization for agents, tools, MCP,
  model options, observability sinks, and workflow launch composition.

## Provider Isolation

Provider-specific code must stay in its own lane. Do not put Plane behavior,
schemas, auth, config, fixtures, or tests inside Jira modules, and do not put
Jira behavior inside Plane modules. The same rule applies to every provider
pair.

Shared provider helpers are allowed only when they are truly provider-agnostic.
For example, `src/core/providers/auth.ts` may read `luna.auth.json` and expose
unknown provider data, but it must not validate or mention Jira, Plane, GitHub,
or any other provider-specific credential shape. Provider-specific validation
belongs under that provider's directory.

Adapters for external providers are provider-owned boundaries. They may import
neutral core contracts and their own provider helper modules, but must not
reach into another provider's directory.

## Do Not Reintroduce Old Architecture

- Do not add `src/workflows/<workflow>.ts`; use the generic `luna` entrypoint.
- Do not add one-off CLI commands like `review-pr <url>`.
- Do not create handwritten built-in name lists outside the active built-in
  registry and metadata map.
- Do not register local tools outside `src/core/tools/catalog.ts`.
- Do not keep compatibility wrappers or deadcode.
- Do not put Flue-specific implementation files back under `src/core/flue-*` or
  provider-neutral modules.
- Do not add built-in barrel exports such as `built-ins/index.ts`.

## Verification

Run focused tests for the changed area, `npm run typecheck`,
`npm run typecheck:unused-src`, and `npm run lint:unused`. Before
finishing a broad change, run `npm test` and `npm run build`.
