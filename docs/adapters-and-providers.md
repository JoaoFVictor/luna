# Adapters And Providers

This document separates input adapters, provider modules, routing, and the
current Flue runtime adapter.

## Two Adapter Meanings

Luna uses the word adapter in two different places.

Input adapters live under `src/adapters/<id>/`. They turn an external input,
such as a GitHub PR URL or Jira task URL, into Luna's normalized invocation
shape.

The runtime adapter currently lives under `src/core/agent-runtime/flue/`. It
materializes Luna workflow nodes into Flue agents, tools, MCP tools, subagents,
model options, usage records, and logs.

Keep those concepts separate. A URL input adapter should not know how Flue
materializes an agent session, and the Flue runtime adapter should not own a
provider's source API schema.

## Invocation Shape

Input adapters return `InvocationSchema`. The schema is strict and versioned.
It contains source, event, action, optional target, repository hints, subject,
actor, references, and payload.

Adapters normalize provider-specific source data into that shape. They may
fetch source metadata, parse URLs, map repository hints, and return coded
errors. They should preserve provider payloads where later provider-owned code
needs them.

Adapters do not:

- run Flue.
- choose workflows with an LLM.
- create worktrees.
- write run artifacts.
- commit, push, or open change requests.
- prove that repository config exists.

Repository hints from an adapter are only hints. `config/repositories.yaml`
remains authoritative, and repository resolution happens later in the workflow
runner.

## CLI And Routing

The CLI supports one shape:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:<id> --from <adapter> <value>
```

For tests and automation, use normalized JSON:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:<id> --input path/to/invocation.json
```

The CLI target override sets `invocation.target`. URL adapters should usually
omit `target`; routing can then come from the CLI override, an invocation target
provided by another caller, or `config/routing.yaml`.

Routing is ordered and deterministic. `routeInvocation` iterates
`config/routing.yaml` and never asks a model which workflow to run. The
advertised precedence depends on keeping the explicit-target route first in
the routing config.

There is no workflow-specific command such as a special PR-review command.
Everything goes through `run` plus a target, input adapter, or JSON invocation.

## Provider Ownership

Provider-specific code belongs under `src/providers/<provider>/` or the
matching provider-owned input adapter.

A provider owns:

- provider auth validation.
- provider config schema.
- source API payload interpretation.
- task or PR context rendering.
- provider-specific report rendering.
- change-request actions for that provider.

A provider does not own:

- generic workflow definitions.
- another provider's auth or schema.
- generic context intake.
- generic tool contracts.
- the Flue runtime adapter.

Shared provider helpers may handle neutral mechanics, such as reading
`luna.auth.json` as unknown provider data. Provider-specific validation belongs
inside the provider module.

Current source providers include GitHub, Jira, and Plane. GitHub owns PR
review preflight, repository context, and GitHub change-request actions. Jira
and Plane own task context and final implementation report rendering for their
task sources.

## Config And Secrets

Core project config lives in `config/`.

`auth.json` is runtime/model auth created by Pi login.

`luna.auth.json` is Luna provider auth. Jira credentials are keyed by the
instance id in `config/jira.yaml`; Plane API keys are keyed by the instance id
in `config/plane.yaml`.

Do not mix those files in docs or code. Runtime model auth and source-provider
auth are separate concerns.

## Composition Roots

Some files intentionally compose generic and provider-specific pieces:

- `src/adapters/registry.ts`
- `src/core/providers/built-ins.ts`
- `src/core/agent-runtime/flue/workflow-factory.ts`
- `src/core/change-request/default-registry.ts`

Composition belongs there, not in leaf modules. A generic built-in should not
import a Jira schema. A Plane provider module should not borrow a GitHub config
type. A Flue runner should not parse a Jira URL.

## What This Layer Does

- Converts external inputs into normalized invocations.
- Keeps source-provider API details inside provider-owned code.
- Keeps deterministic routing visible in config.
- Separates model runtime auth from provider source auth.
- Gives the workflow runner enough normalized data to resolve repositories and
  execute graphs.

## What This Layer Does Not Do

- It does not choose workflows with model judgment.
- It does not create workflow artifacts.
- It does not mutate repositories.
- It does not use repository hints as configuration authority.
- It does not let one provider validate another provider's payload.

## Source Map

- Input adapter contract: `src/adapters/types.ts`
- Input adapter registry: `src/adapters/registry.ts`
- Invocation schema: `src/core/invocation/types.ts`
- Router: `src/core/invocation/router.ts`
- CLI: `src/core/agent-runtime/flue/cli.ts`
- Runtime factory: `src/core/agent-runtime/flue/workflow-factory.ts`
- Config bootstrap: `src/core/configured-workflow/bootstrap.ts`
- Provider built-in composition: `src/core/providers/built-ins.ts`
- Shared provider auth loader: `src/core/providers/auth.ts`
- Repository resolution: `src/core/workflow/workspace-resolver.ts`

Useful tests include `tests/core/cli.test.ts`,
`tests/adapters/input-adapter-registry.test.ts`,
`tests/adapters/github-pr-url-adapter.test.ts`,
`tests/adapters/jira-task-url-adapter.test.ts`,
`tests/adapters/plane-task-url-adapter.test.ts`,
`tests/core/router.test.ts`, `tests/core/invocation-helpers.test.ts`,
`tests/core/workspace-resolver.test.ts`, `tests/core/config-loader.test.ts`,
and provider auth/context tests under `tests/core/`.
