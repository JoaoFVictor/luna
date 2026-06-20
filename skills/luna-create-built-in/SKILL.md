---
name: luna-create-built-in
description: Use when creating or modifying Luna built-in workflow steps under src/core/built-ins/, including defineBuiltInStep, catalog registration, metadata, workflow YAML uses values, state helpers, reports, worktree capture, deferral, and built-in tests.
---

# Luna Create Built-In

Read `examples/new-built-in.md` first. Built-ins are deterministic TypeScript
capabilities called by workflow YAML.

## Files

- `src/core/built-ins/<domain>.ts`: exported step objects.
- `src/core/built-ins/state.ts`: shared state/input parsing helpers only.
- `src/core/built-ins/catalog.ts`: single source of supported built-in names.
- `src/core/built-ins/index.ts`: public runtime registry and exports.

Use `defineBuiltInStep({ name, metadata?, run })`. Export each step
individually as `<camelName>BuiltIn`.

## Metadata

Most built-ins need no metadata.

- `capturesWorkspace`: step returns a `WorkspaceRecord` for `state.workspace`.
- `deferUntilAfterWorkspaceLifecycle`: final report step runs after workspace
  preserve/cleanup decision.

Do not add name checks to `configured-workflow-runner.ts`; runner behavior comes
from metadata.

## Registration

Add new built-ins to `defaultBuiltInSteps` in `catalog.ts`. Do not create a
second built-in name list in workflow validation or runner code.

## Testing

Create focused domain tests under `tests/core/`, and update
`tests/core/built-ins-registry.test.ts` for catalog/metadata changes.

Run:

```sh
npm test -- tests/core/built-ins-registry.test.ts tests/core/built-ins-*.test.ts
npm test -- tests/core/workflow-definition.test.ts tests/core/configured-workflow-runner.test.ts
npm run typecheck
```

Update README/examples when adding public built-ins.
