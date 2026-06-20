---
name: luna-create-tool
description: Use when creating or modifying Luna local tools for agents, including @flue/runtime defineTool, src/tools, src/core/flue-tool-registry.ts, agent.yaml tools entries, agent mode restrictions, repository-bound cwd behavior, and Flue tool tests.
---

# Luna Create Tool

Read `examples/new-tool.md` first. Local tools are deterministic TypeScript
functions exposed to Flue agents.

## Boundary

Use a tool for small local capabilities an agent can call, such as git status or
diff summary. Do not use tools for workflow orchestration or input
normalization.

Good tools:

- receive a bound `cwd` from Luna;
- validate parameters with Valibot;
- return compact model-readable output;
- are allowed only for suitable agent modes.

## Files

- Implement tool factories under `src/tools/`.
- Register IDs in `src/core/flue-tool-registry.ts`.
- Attach IDs in `agents/<id>/agent.yaml`.

Registry IDs may contain dots, like `repository.status`. Flue tool names should
be safe model-facing names, like `repository_status`.

## Testing

Update `tests/core/flue-tool-registry.test.ts`. Cover resolution, execution,
unknown tool ids, and agent mode restrictions.

Run:

```sh
npm test -- tests/core/flue-tool-registry.test.ts tests/core/flue-agent-capabilities.test.ts
npm test -- tests/core/flue-modules.test.ts
npm run typecheck
```

Update README/examples when adding reusable public tools.
