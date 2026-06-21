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

## Files

- Define runtime-neutral tool contracts in `src/core/tools/contracts.ts`.
- Implement domain tools under `src/core/tools/`.
- Register public tool IDs in `src/core/tools/catalog.ts`.
- Materialize Flue `ToolDefinition`s only in
  `src/core/agent-runtime/flue/tool-registry.ts`.
- Attach IDs in `agents/<id>/agent.yaml`.

Tool IDs may contain dots, like `repository.status`. The Flue adapter converts
them into safe model-facing names, like `repository_status`. Do not import
`@flue/runtime` or call `defineTool` from `src/core/tools/**`; that belongs only
at the Flue adapter boundary.

## Testing

Update `tests/core/flue-tool-registry.test.ts`. Cover resolution, execution,
unknown tool ids, and agent mode restrictions.

Run:

```sh
rtk npm test -- tests/core/flue-tool-registry.test.ts tests/core/flue-agent-capabilities.test.ts
rtk npm test -- tests/core/flue-modules.test.ts
rtk npm run typecheck
```

Update README/examples when adding reusable public tools.
