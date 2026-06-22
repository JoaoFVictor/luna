---
name: luna-review-change
description: Use when reviewing Luna code, documentation, architecture, workflow, agent, adapter, built-in, tool, MCP, or subagent changes for correctness, deadcode, old design remnants, maintainability, tests, and docs/examples completeness.
---

# Luna Review Change

Review Luna changes as architecture, not just code.

## Critical Checks

- No old architecture: no per-workflow TypeScript entrypoints, no one-off CLI
  workflow commands, no compatibility wrappers, no duplicate built-in name lists.
- Boundaries hold: adapters normalize, router routes, workflows orchestrate,
  agents judge, built-ins execute deterministic workflow actions, tools serve
  agents.
- Agents stay reusable and schemas match workflow inputs.
- Provider-facing built-ins are registered through
  `src/core/providers/built-ins.ts`; runtime-neutral built-ins and shared
  catalog helpers stay under `src/core/built-ins/`.
- Tools are registered only through `src/core/tools/catalog.ts`; Flue
  materialization stays in `src/core/agent-runtime/flue/tool-registry.ts`.
- Flue-specific runner, capabilities, MCP, subagent profile, Pi auth, model
  projection, observability parsing, and workflow factory code stays under
  `src/core/agent-runtime/flue/**`.
- Public docs point authors to `agents/<id>/`, `workflows/<id>/`,
  `src/adapters/<id>/`, `src/core/built-ins/`, `src/core/tools/`, and
  `src/core/agent-runtime/flue/`.
- Docs do not recommend old deleted path `src/core/types.ts`.
- Docs do not recommend old deleted path `src/tools/repository-tools.ts`.
- Docs do not recommend old deleted path `src/core/flue-*`.
- Docs do not recommend old deleted path `src/core/implementation-*`.
- Docs do not recommend old built-ins barrel paths such as `built-ins/index.ts`.
- Docs/examples changed when public behavior or authoring patterns changed.

## Review Order

1. Inspect the diff and identify touched extension point.
2. Search for dead imports, old names, duplicate lists, and stale examples.
3. Check tests cover both success and failure paths.
4. Verify README/examples explain the new path for a person new to Luna.
5. Run focused tests, `npm run typecheck`,
   `npm run typecheck:unused-src`, and `npm run lint:unused`.

## Useful Scans

```sh
rg -n "built-in-steps|src/workflows/.*\\.ts|TODO|TBD" AGENTS.md README.md examples skills src tests
rg -n "from \".*built-in-steps\\.js\"|from \"../../src/core/built-in-steps\\.js\"" src tests
rg -n "src/core/flue-|src/core/pi-auth|observability/flue-log-sink" src tests examples skills
rg -n "src/core/types\\.ts|src/tools/repository-tools\\.ts|src/core/implementation-|built-ins/index\\.ts" README.md examples skills src tests
```

Do not add `review-pr <url>` except inside docs as an explicit anti-example.
It must not appear as a real CLI command, script, package entry, or source
implementation.

For broad changes, run:

```sh
npm test
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
npm run build
```
