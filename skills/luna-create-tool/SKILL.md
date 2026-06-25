---
name: luna-create-tool
description: Use when creating or modifying Luna local tools for agents, including src/core/tools contracts/catalog, agent.yaml tools entries, agent mode restrictions, repository-bound cwd behavior, and Flue adapter materialization tests.
---

# Luna Create Tool

Read `examples/new-tool.md` first. Local tools are deterministic TypeScript
functions defined in Luna's runtime-neutral tool catalog and materialized for
Flue at the runtime adapter boundary.

## Boundary

Use a tool for small local capabilities an agent can call, such as git status or
diff summary. Do not use tools for workflow orchestration or input
normalization.

Good tools:

- receive a bound `cwd` from Luna;
- validate parameters with Valibot;
- return compact model-readable output;
- are allowed only for suitable agent modes.
- declare explicit safety metadata.

## Provider Boundaries

Tools under `src/core/tools/` are runtime-neutral by default. Do not put
provider-specific auth, config, schemas, URLs, or payload parsing into a
generic tool module. If a tool truly needs provider behavior, keep the
provider-specific code under the owning `src/providers/<provider>/` module and
expose only a neutral tool contract through `src/core/tools/`.

Never reuse another provider's module as a convenience wrapper. Plane behavior
does not belong in Jira modules, Jira behavior does not belong in Plane
modules, and the same rule applies to every provider pair.

## Files

Local tools are owned by `src/core/tools/`. Do not add tool implementations
under old `src/tools/` paths.

- Define runtime-neutral tool contracts in `src/core/tools/contracts.ts`.
- Implement domain tools under `src/core/tools/`.
- Register public tool IDs in `src/core/tools/catalog.ts`.
- Materialize Flue `ToolDefinition`s only in
  `src/agent-runtimes/flue/tool-registry.ts`.
- Attach IDs in `agents/<id>/agent.yaml`.

Tool IDs may contain dots, like `repository.status`. The Flue adapter converts
them into safe model-facing names, like `repository_status`. Do not import
`@flue/runtime` or call `defineTool` from `src/core/tools/**`; that belongs only
at the Flue adapter boundary.

Keep Flue-specific tests and imports pointed at `src/agent-runtimes/flue/**`.
Existing legacy Flue code under `src/core/agent-runtime/flue/**` may remain
only until the Task 18 atomic cutover.
Do not add forwarding files under old `src/core/flue-*.ts` paths.

## Testing

Update `tests/core/flue-tool-registry.test.ts`. Cover resolution, execution,
unknown tool ids, and agent mode restrictions.

Run:

```sh
npm test -- tests/core/flue-tool-registry.test.ts tests/core/flue-agent-capabilities.test.ts
npm test -- tests/core/flue-modules.test.ts
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```

Update README/examples when adding reusable public tools.
