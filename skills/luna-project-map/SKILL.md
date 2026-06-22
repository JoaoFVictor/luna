---
name: luna-project-map
description: Use when first working in Luna, orienting to its architecture, deciding where a change belongs, or explaining adapters, workflows, agents, built-ins, tools, MCP, subagents, artifacts, and local-first runtime flow.
---

# Luna Project Map

Luna is a local-first multi-agent orchestration repo with Flue as the current
agent runtime adapter. Start by reading `README.md` and
`examples/configured-workflows.md`.

Runtime flow:

```text
adapter -> invocation -> router -> workflow graph -> built-ins/agents/agent loops -> artifacts
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
- Workflow: order built-ins, agents, and agent loops.
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

## Do Not Reintroduce Old Architecture

- Do not add `src/workflows/<workflow>.ts`; use the generic `luna` entrypoint.
- Do not add one-off CLI commands like `review-pr <url>`.
- Do not duplicate built-in names outside `src/core/built-ins/catalog.ts`.
- Do not register local tools outside `src/core/tools/catalog.ts`.
- Do not keep compatibility wrappers or deadcode.
- Do not put Flue-specific implementation files back under `src/core/flue-*` or
  provider-neutral modules.
- Do not add built-in barrel exports such as `built-ins/index.ts`.

## Verification

Run focused tests for the changed area, `rtk npm run typecheck`,
`rtk npm run typecheck:unused-src`, and `rtk npm run lint:unused`. Before
finishing a broad change, run `rtk npm test` and `rtk npm run build`.
