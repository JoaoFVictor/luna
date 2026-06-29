---
name: luna-project-map
description: Use when first working in Luna, orienting to its architecture, deciding where a change belongs, or explaining adapters, workflows, agents, capabilities, tools, MCP, subagents, artifacts, providers, and runtime flow.
---

# Luna Project Map

Luna runs deterministic YAML workflows through a native platform and runtime
composition layer.

```text
input adapter or invocation JSON
  -> deterministic router
  -> workflow YAML
  -> native platform registrations
  -> runtime scheduler
  -> capability built-ins / agents / patterns / gates
  -> artifacts
```

## Extension Points

| Need | Location |
| --- | --- |
| Workflow orchestration | `workflows/<id>/` |
| Workflow runtime config schema | `workflows/<id>/config.schema.json` plus workflow `config:` |
| Reusable model role | `agents/<id>/` |
| Public deterministic capability | `src/capabilities/<id>/` |
| Provider-owned API/auth/payload/report/publish behavior | `src/providers/<provider>/` |
| Input adapter contract/registry plumbing | `src/adapters/` |
| Native plugin registration and workflow execution wiring | `src/platform/native/` |
| Runtime backends, scheduler, LangGraph adapter, composition | `src/runtime/` |
| Runtime-neutral contracts and validation | `src/core/` |
| Concrete agent runtime | `src/agent-runtimes/<runtime>/` |
| Pi runtime adapter | `src/agent-runtimes/pi/` |
| Agent/runtime guidance | `skills/<id>/SKILL.md` |

## Boundaries

- Adapter: normalize external input into an invocation.
- Router: choose workflow deterministically.
- Workflow: order nodes, gates, policies, inputs, and artifacts.
- Capability: publish built-ins, patterns, gates, tools, ports, policies,
  schemas, and publishers.
- Agent: reusable model role with structured output.
- Context intake: deterministic repository/agent file collection.
- Provider: source-system auth, config, URLs, payloads, reports, publishing.
- Runtime composition: select backends, runtimes, ports, observability.
- Runtime adapter: materialize model calls and tools for a concrete runtime.

## Rules

- Do not add per-workflow TypeScript entrypoints.
- Do not add workflow-specific CLI commands.
- Do not route with model judgment.
- Do not put provider schemas/auth/payloads in generic core or neutral
  capabilities.
- Do not put Pi/runtime SDK details outside `src/agent-runtimes/<runtime>/`.
- Register public ids through capability manifests.
- Keep gate policy in workflow YAML.
- Keep workflow runtime config declared by the workflow. Use
  `config.file`/`config.schema`, validate with `workflows/<id>/config.schema.json`,
  and read values through `$.config`; do not add workflow-id branches in the
  runtime. Full contract: `docs/workflow-runtime-config.md`.
- Keep context explicit through `context.collect_context`.
- Treat MCP as configured policy only unless the selected runtime supports it.

## Verification

Run focused tests for the changed layer plus:

```bash
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```

For broad changes, also run `npm test` and `npm run build`.
