---
name: luna-create-built-in
description: Use when creating or modifying Luna built-in workflow steps, including provider-facing built-ins, runtime-neutral built-ins under src/core/built-ins/, defineBuiltInStep, catalog registration, metadata, workflow YAML uses values, state helpers, reports, worktree capture, deferral, and built-in tests.
---

# Luna Create Built-In

Read `examples/new-built-in.md` first. Built-ins are deterministic TypeScript
capabilities called by workflow YAML.

## Files

- `src/core/built-ins/<domain>.ts`: runtime-neutral exported step objects.
- `src/core/providers/<provider>/built-ins.ts`: provider-specific exported step
  objects.
- `src/core/built-ins/state.ts`: shared state/input parsing helpers only.
- `src/core/built-ins/catalog.ts`: shared catalog helpers and runtime-neutral
  built-in exports.
- `src/core/providers/built-ins.ts`: active provider-facing built-in registry
  used by the Flue workflow factory.
- `src/core/write-mode/`: owned services and contracts for write-mode git
  branches, worktrees, gates, lifecycle, and transaction journals.

Use `defineBuiltInStep({ name, metadata?, run })`. Export each step
individually as `<camelName>BuiltIn`.

## Provider Boundaries

Keep runtime-neutral built-ins provider-agnostic. Code under
`src/core/built-ins/` must not mention provider-specific auth, config, schemas,
URLs, or payload details.

Keep provider-specific built-ins isolated under their own provider directory. A
Plane built-in must not add Plane behavior to Jira modules, and a Jira built-in
must not add Jira behavior to Plane modules. Shared helpers are allowed only
when they are truly provider-agnostic; provider-specific validation belongs
under `src/core/providers/<provider>/`.

## Metadata

Most built-ins need no metadata.

- `capturesWorkspace`: step returns a `WorkspaceRecord` for `state.workspace`.
- `deferredLifecycle: "final_report"`: final report step runs after workspace
  preserve/cleanup decision.

Do not add name checks to `src/core/configured-workflow/runner.ts`; runner
behavior comes from metadata.

## Registration

Add provider-facing built-ins to `defaultBuiltInSteps` in
`src/core/providers/built-ins.ts`. Keep runtime-neutral built-ins and shared
catalog helpers under `src/core/built-ins/`. Do not create another handwritten
built-in name list in workflow validation or runner code.
Do not add barrel exports for new domain files; import owning modules directly.
Do not create compatibility wrappers for old built-in module paths.

## Testing

Create focused domain tests under `tests/core/`, and update
`tests/core/built-ins-registry.test.ts` for catalog/metadata changes.

Run:

```sh
npm test -- tests/core/built-ins-registry.test.ts tests/core/built-ins-*.test.ts
npm test -- tests/core/workflow-definition.test.ts tests/core/configured-workflow-runner.test.ts
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```

Update README/examples when adding public built-ins.
