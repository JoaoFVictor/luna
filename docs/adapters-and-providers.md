# Adapters And Providers

This document covers input adapters, provider modules, routing, and provider
auth boundaries.

## Input Adapter Contract

The shared adapter contract is small:

- `src/adapters/types.ts`: `AdapterInput`, `AdapterContext`, `InputAdapter`.
- `src/adapters/registry.ts`: registry helpers and default CLI context.

`AdapterInput` is currently CLI-shaped: `{ kind: "cli"; value: string }`.
`AdapterContext` supplies `projectRoot`, `configRoot`, `env`, `fetch`, and
`executeJson`.

Adapters return the strict invocation schema from
`src/core/router/invocation.ts`.

## Provider-Owned Adapters

Concrete adapters are provider-owned today:

- GitHub PR URL adapter: `src/providers/github/input-adapter.ts`
- Jira task URL adapter: `src/providers/jira/input-adapter.ts`
- Plane task URL adapter: `src/providers/plane/input-adapter.ts`

They are registered through native platform plugins in
`src/platform/native/native-platform-plugins.ts`, then flattened into the
adapter registry in `src/platform/native/native-platform-registrations.ts`.

This means `src/adapters/**` is shared plumbing, not where every concrete
provider adapter necessarily lives.

Webhook adapters follow the same ownership rule. The HTTP ingress is one
provider-parametric route, `POST /webhooks/:provider`, implemented by generic
`src/webhooks/**` plumbing. GitHub and Plane own their signature verification
and payload normalization under `src/providers/github/` and
`src/providers/plane/`.

Adding another webhook provider should mean adding a provider-owned webhook
adapter, registering its factory in native platform plugins, and adding config
for its `secret_ref`. It should not add another HTTP endpoint.

Provider connection probes follow the same ownership rule. The provider-neutral
contract and registry live under `src/core/providers/`, while each concrete
probe lives beside its provider and is registered by the native plugin. A probe
must use a fixed, minimal authenticated operation; it cannot accept a user URL,
issue, pull request, or other resource locator. The Studio exposes its timeout
and effect classes before execution and returns only a bounded, redacted status.

The current probes are:

- GitHub: `gh api user --jq .login`; this reads the configured credential,
  performs a network read, and executes the local `gh` client.
- Jira: `GET /rest/api/3/myself` for each configured instance with basic API
  token authentication.
- Plane: `GET /api/v1/users/me/` for each configured instance with
  `X-API-Key`; `app.plane.so` is mapped to the public `api.plane.so` API origin,
  while self-hosted origins are preserved.

Successful evidence is session-local and tied to the exact probe id. A failed
later probe clears previous healthy evidence. Adapter preview is intentionally
unrelated: loading an issue or pull request does not mark a provider healthy.

## Invocation Boundary

Invocation is the provider/data boundary. It has fixed top-level fields such as
`source`, `event`, `action`, optional `target`, repository hint, subject,
actor, references, and generic `payload`.

Provider-specific data can remain under `payload`, but provider-owned later
steps must parse it strictly before using it. Do not let generic workflow or
core modules depend on raw provider payload shapes.

Repository hints are not configuration authority. Workflow execution resolves
the repository against `config/repositories.yaml`.

## Routing

Routing is deterministic, first-match JSONata over `{ invocation }` in
`config/routing.yaml`.

The CLI flow is:

1. Load invocation from `--input`, or load an adapter from `--from`.
2. Apply `--target workflow:<id>` as an invocation target when supplied.
3. Route with `config/routing.yaml`.
4. Execute the workflow target.

The default routing config puts explicit target first, GitHub PR events to
`workflow:code-review`, Jira issue selections to `workflow:implementation`, and
Plane issue selections plus webhook `create`/`update` events to
`workflow:implementation`.

Plane implementation invocations still need a repository hint. Plane webhook
normalization reads the same `provider:owner/repo` label shape used by the
Plane task URL adapter and maps it to the invocation repository.

## Provider Ownership

A provider owns:

- provider auth validation.
- provider config schema.
- URL parsing and source API calls.
- provider payload interpretation.
- task or PR context rendering.
- provider-specific final reports.
- pull request review publishing for that provider.
- change-request publishing for that provider.

A provider does not own:

- generic workflow contracts.
- another provider's auth/config/schema/payload.
- runtime adapter behavior.
- generic context intake.
- generic capability contracts.

Shared provider helpers may read `.luna/auth/luna.auth.json` as unknown
provider data. Provider-specific validation belongs in the owning provider
module.

Adapter JSON commands execute through the shared bounded process runner: no
implicit shell, reduced environment, explicit timeout and stdout/stderr limits,
strict UTF-8 JSON decoding, abort propagation, and whole-process-group
termination. Errors expose a stable reason but never echo raw command output.
Provider adapters must use the supplied `executeJson` context instead of spawning
their own unbounded command trees.

Generic workflow and capability modules should depend on provider-neutral ports,
not provider-specific factories. For example, the `pull-request-review`
capability exposes `pull-request-review.publish` and the
`pull-request-review.provider` port. The GitHub implementation lives under
`src/providers/github/pull-request-review/` and is registered through native
platform plugin composition.

## Current Providers

GitHub:

- Parses GitHub PR URLs.
- Uses the shared GitHub CLI helper for provider-owned `gh` calls.
- Uses `gh` authentication from `GH_CONFIG_DIR` under the Luna auth root, not
  `luna.auth.json`.
- Uses Git commit identity from `.luna/auth/git/config` when trusted write
  workflows commit in the container runtime.
- Provides GitHub pull request review publishing.
- Provides GitHub change-request publishing.

Jira:

- Reads `config/jira.yaml`.
- Reads credentials from `.luna/auth/luna.auth.json`.
- Fetches Jira issue data and optional repository hints from configured fields.
- Renders task context/final implementation reports for Jira issues.

Plane:

- Reads `config/plane.yaml`.
- Reads API keys from `.luna/auth/luna.auth.json`.
- Supports browse and project issue URLs.
- Fetches Plane issue data and optional repository hints from labels.
- Renders task context/final implementation reports for Plane issues.
- Tests configured credentials with the provider-owned current-user probe.

## Composition Roots

Provider/generic wiring belongs in explicit composition roots:

- `src/platform/native/native-platform-plugins.ts`
- `src/platform/native/native-platform-registrations.ts`
- `src/platform/native/native-workflow-executors.ts`
- `src/providers/built-ins.ts`
- `src/core/providers/registry.ts`

Leaf modules should stay in their lane.

`src/core/providers/registry.ts` is intentionally generic provider-port
plumbing. Do not create one-off provider registry modules per capability unless
the capability has genuinely different lookup semantics.

## Source Map

- Adapter contract: `src/adapters/types.ts`
- Adapter registry helpers: `src/adapters/registry.ts`
- Invocation schema: `src/core/router/invocation.ts`
- Router evaluator: `src/core/router/router.ts`
- Router definition schema: `src/core/router/router-definition.ts`
- CLI: `src/cli.ts`
- Native platform plugins: `src/platform/native/native-platform-plugins.ts`
- Repository resolution: `src/core/workflow/workspace-resolver.ts`
- Shared auth root and file reader: `src/core/auth/`
- Repository hint parser: `src/providers/repository-hints/repository-reference.ts`
