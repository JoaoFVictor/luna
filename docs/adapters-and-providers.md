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

## Current Providers

GitHub:

- Parses GitHub PR URLs.
- Uses `gh api` through `executeJson`.
- Uses `gh` authentication from `GH_CONFIG_DIR` under the Luna auth root, not
  `luna.auth.json`.
- Uses Git commit identity from `.luna/auth/git/config` when trusted write
  workflows commit in the container runtime.
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

## Composition Roots

Provider/generic wiring belongs in explicit composition roots:

- `src/platform/native/native-platform-plugins.ts`
- `src/platform/native/native-platform-registrations.ts`
- `src/platform/native/native-workflow-executors.ts`
- `src/providers/built-ins.ts`
- `src/capabilities/change-request/provider-registry.ts`

Leaf modules should stay in their lane.

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
