---
name: luna-create-adapter
description: Use when creating or modifying Luna input adapters, especially provider-owned URL/API adapters, normalized invocations, native plugin registration, CLI --from support, deterministic routing, and adapter tests.
---

# Luna Create Adapter

Input adapters turn external values into Luna invocations. They do not run
workflows.

## Current Shape

Shared contracts live in:

- `src/adapters/types.ts`
- `src/adapters/registry.ts`

Concrete provider adapters currently live under provider modules, for example:

- `src/providers/github/input-adapter.ts`
- `src/providers/jira/input-adapter.ts`
- `src/providers/plane/input-adapter.ts`

Register adapters through native platform plugins in
`src/platform/native/native-platform-plugins.ts`.

## Responsibilities

An adapter should:

- parse and validate the external value.
- fetch source metadata through source-native APIs/tools.
- return `InvocationSchema.parse(...)` from `src/core/router/invocation.ts`.
- preserve repository hints, subject, actor, references, and provider payload.
- produce clear coded errors for invalid input or missing auth/config.

An adapter must not:

- choose workflows with an LLM.
- create worktrees.
- call agent runtimes.
- write artifacts.
- commit, push, or create change requests.
- validate another provider's auth/config/schema.

## Routing

Adapters should normally omit `target`. Workflow selection comes from CLI
`--target`, invocation `target`, or `config/routing.yaml`.

## Testing

Add tests under `tests/adapters/` for valid input, invalid input,
auth/config/API failures, and normalized invocation shape.

Then run:

```bash
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```
