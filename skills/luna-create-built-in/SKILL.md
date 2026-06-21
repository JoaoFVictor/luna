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
- `src/core/write-mode/`: owned services and contracts for write-mode git
  branches, worktrees, gates, lifecycle, and transaction journals.

Use `defineBuiltInStep({ name, metadata?, run })`. Export each step
individually as `<camelName>BuiltIn`.

## Metadata

Most built-ins need no metadata.

- `capturesWorkspace`: step returns a `WorkspaceRecord` for `state.workspace`.
- `deferredLifecycle: "final_report"`: final report step runs after workspace
  preserve/cleanup decision.

Do not add name checks to `src/core/configured-workflow/runner.ts`; runner
behavior comes from metadata.

## Registration

Add new built-ins to `defaultBuiltInSteps` in `catalog.ts`. Do not create a
second built-in name list in workflow validation or runner code.
Do not add barrel exports for new domain files; import owning modules directly.
Do not create compatibility wrappers for old built-in module paths.

## Testing

Create focused domain tests under `tests/core/`, and update
`tests/core/built-ins-registry.test.ts` for catalog/metadata changes.

Run:

```sh
rtk npm test -- tests/core/built-ins-registry.test.ts tests/core/built-ins-*.test.ts
rtk npm test -- tests/core/workflow-definition.test.ts tests/core/configured-workflow-runner.test.ts
rtk npm run typecheck
rtk npm run typecheck:unused-src
rtk npm run lint:unused
```

Update README/examples when adding public built-ins.
