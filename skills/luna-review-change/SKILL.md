---
name: luna-review-change
description: Use when reviewing Luna code, documentation, architecture, workflow, agent, adapter, built-in, tool, MCP, or subagent changes for correctness, deadcode, stale design remnants, maintainability, tests, and docs/examples completeness.
---

# Luna Review Change

Review Luna changes as architecture, not just code.

## Critical Checks

- Architecture rules hold: no per-workflow TypeScript entrypoints, no one-off
  CLI workflow commands, no compatibility wrappers, no duplicate built-in name
  lists.
- Boundaries hold: adapters normalize, router routes, workflows orchestrate,
  agents judge, built-ins execute deterministic workflow actions, tools serve
  agents.
- Agents stay reusable and schemas match workflow inputs.
- Runtime-neutral core contracts stay under `src/core/workflow/`,
  `src/core/built-ins/`, `src/core/context/`, and `src/core/tools/` without
  provider SDKs, auth, schemas, payload shapes, runtime SDKs, or
  repository-specific behavior.
- Provider-owned code stays under `src/providers/<provider>/`, including
  provider SDK/API integration, auth, schemas, payload mapping, reports,
  provider built-ins, and change-request services. Provider-owned capabilities
  are wired through composition roots, not generic core leaf modules.
- Provider responsibilities stay isolated. No provider-specific module,
  adapter, built-in, tool helper, test, fixture, or docs example should import,
  validate, store, or mention another provider's auth/config/schema/payload
  shape. Shared helpers must stay provider-agnostic.
- Tools are registered only through `src/core/tools/catalog.ts`;
  runtime-specific materialization stays under `src/agent-runtimes/<runtime>/`.
- Pi-specific adapter, local tool materialization, Pi auth, model projection,
  and observability parsing belong under
  `src/agent-runtimes/pi/**`.
- Public docs point authors to `agents/<id>/`, `workflows/<id>/`,
  `src/adapters/<id>/`, `src/core/workflow/`, `src/core/built-ins/`,
  `src/core/tools/`, `src/providers/<provider>/`, and
  `src/agent-runtimes/<runtime>/`.
- Docs point to `src/core/runtime/`, `src/core/tools/`,
  `src/agent-runtimes/pi/`, and `src/providers/<provider>/`.
- Docs/examples changed when public behavior or authoring patterns changed.

## Review Order

1. Inspect the diff and identify touched extension point.
2. Search for dead imports, stale names, duplicate lists, and stale examples.
3. Check tests cover both success and failure paths.
4. Verify README/examples explain the new path for a person new to Luna.
5. Run focused tests, `npm run typecheck`,
   `npm run typecheck:unused-src`, and `npm run lint:unused`.

## Useful Scans

```sh
rg -n "built-in-steps|src/workflows/.*\\.ts|TODO|TBD" AGENTS.md README.md examples skills src tests
rg -n "from \".*built-in-steps\\.js\"|from \"../../src/core/built-in-steps\\.js\"" src tests
rg -n "src/core/pi-auth|observability/.+-log-sink" src tests examples skills
rg -n "src/core/.+provider|src/core/.+runtime" AGENTS.md skills src tests
rg -n "src/tools/.+tools|src/core/.+implementation|built-ins/.+\\.ts" README.md examples skills src tests
rg -n "swing(go)|s[w]g" AGENTS.md README.md examples skills src tests
```

Do not add workflow-specific CLI commands. They must not appear as real CLI
commands, scripts, package entries, or source implementations.

For broad changes, run:

```sh
npm test
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
npm run build
```
