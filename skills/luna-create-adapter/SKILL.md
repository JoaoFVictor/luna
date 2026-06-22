---
name: luna-create-adapter
description: Use when creating or modifying Luna input adapters under src/adapters/, including GitHub, Jira, Slack, API, issue, URL, or file inputs, normalized invocations, adapter registry entries, CLI --from support, deterministic routing, and adapter tests.
---

# Luna Create Adapter

Read `examples/new-adapter.md` first. Adapters convert external input into
Luna's normalized invocation shape so users do not hand-write JSON.

## Responsibilities

An adapter should:

- parse and validate the external value;
- fetch source metadata through source-native APIs/tools;
- return `InvocationSchema.parse(...)`;
- preserve repository, subject, references, and payload data agents need;
- produce clear errors for invalid input or missing auth.

An adapter must not:

- run Flue or workflows;
- create worktrees;
- write final artifacts;
- decide workflow routing with an LLM;
- enable commit/push/PR gates.

## Files

```text
src/adapters/<adapter-id>/
  adapter.ts
  index.ts
```

Register once in `src/adapters/registry.ts`. The CLI resolves
`--from <adapter>` through that registry.

URL adapters should omit `target` unless a CLI target override is used.
Workflow selection comes from `--target workflow:<id>`, invocation `target`, or
`config/routing.yaml`.

## Testing

Add tests under `tests/adapters/`. Cover valid input, invalid input, source
failures, auth/config failures, and normalized invocation shape.

Run:

```sh
npm test -- tests/core/cli.test.ts tests/adapters/<adapter-id>-adapter.test.ts
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```

Update README and `examples/configured-workflows.md` if the adapter is public.
