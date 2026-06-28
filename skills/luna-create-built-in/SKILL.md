---
name: luna-create-built-in
description: Use when creating or modifying Luna capability built-ins, capability manifests, native executor wiring, side-effect policies, workflow YAML uses values, metadata, reports, worktree capture, deferral, and built-in tests.
---

# Luna Create Built-In

Built-ins are deterministic workflow operations exposed by capability
manifests. Add them through `src/capabilities/<capability>/`, not as an
unregistered helper.

## Files

Typical capability-owned files:

```text
src/capabilities/<capability>/
  manifest.ts
  built-ins.ts
```

Shared mechanics live under `src/core/built-ins/**`. Runtime/provider wiring
lives in composition roots such as `src/platform/native/**` or
`src/providers/**`.

## Manifest First

Register public ids in the capability manifest:

- built-in id and schemas.
- required ports.
- side-effect policy when the built-in reads/writes external state.
- docs metadata when useful.

If another capability re-exports the built-in, update that manifest too.

## Side Effects

Write-side-effecting built-ins must have a policy with operation ids,
idempotency scope, and retry semantics. Workflow YAML must declare the matching
`policies:` entry with `operation_id`.

Do not hide side effects in prompts or provider modules.

## Boundaries

- Runtime-neutral capability code must not import provider auth/config/schema,
  provider API payloads, or runtime SDKs.
- Provider-specific built-ins belong under `src/providers/<provider>/` and are
  wired through native/plugin composition.
- Runner behavior should come from metadata, manifest registrations, and
  policies, not name checks.
- Do not add unregistered indirection or barrel exports for paths that are not
  part of the current public surface.

## Testing

Run focused tests for the capability and workflow definition/runner checks,
then:

```bash
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```

Update examples/docs when adding a public built-in.
