# Luna Studio Architecture Decisions

This document records the implementation decisions that turn the Luna Studio
product specification into code. It is intentionally narrower than the product
plan: it fixes ownership, persistence, packaging, and security boundaries that
implementations must follow.

The Studio remains a projection over Luna's existing files, loaders, registries,
compiler, and runtime. It is not a second workflow engine.

## Decision Summary

| ID | Decision | Status |
| --- | --- | --- |
| LS-001 | React, Vite, shadcn/ui, and React Flow for the browser application | Accepted |
| LS-002 | Fastify composition root separate from webhook ingress | Accepted |
| LS-003 | Source-preserving YAML edits and canonical output only for new files | Accepted |
| LS-004 | Presentation metadata stays manifest-owned | Accepted |
| LS-005 | Versioned multi-resource change sets under `.luna/studio` | Accepted |
| LS-006 | Crash-recoverable apply with a durable journal | Accepted |
| LS-007 | Versioned, DTO-only Control API | Accepted |
| LS-008 | Loopback capability session in local mode | Accepted |
| LS-009 | SQLite run ledger with separate logical ports | Accepted |
| LS-010 | Plan/confirm/execute for real runs | Accepted |
| LS-011 | Local layout sidecars are non-semantic | Accepted |
| LS-012 | Templates generate drafts and never become a runtime format | Accepted |
| LS-013 | One project root per Studio process | Accepted |
| LS-014 | Authorization is a control-plane concern | Accepted |
| LS-015 | Test the boundaries, not duplicated browser rules | Accepted |

## LS-001: Browser Stack And Packaging

The browser application lives under `apps/studio/` and uses:

- React with TypeScript for components;
- Vite for development and production bundling;
- Tailwind CSS v4 and shadcn/ui with the current Base UI primitives;
- React Flow for the spatial DAG view;
- a first-party non-spatial outline using the same graph projection.

The repository owns the generated shadcn component source. Initialization follows
the official [shadcn Vite setup](https://ui.shadcn.com/docs/installation/vite),
and the complete current registry is installed with the documented
[`shadcn add --all`](https://ui.shadcn.com/docs/cli) command. `components.json`
records the selected Base UI preset and aliases. Generated components are treated
as normal source: they pass type, unused-code, accessibility, and thermonuclear
review gates and may be simplified when a generated abstraction is not useful.

“All components” means all registry components available from the pinned shadcn
CLI during the initial generation, including the current conversation primitives.
The generated inventory is committed so future upstream additions are deliberate
updates, not nondeterministic build-time downloads.

React Flow was selected because its public contract includes keyboard-focusable
nodes and edges, selection and movement by keyboard, ARIA descriptions, and live
announcements. These features help, but do not replace the outline required by
the Studio acceptance criteria. See the
[React Flow accessibility guide](https://reactflow.dev/learn/advanced-use/accessibility).

The application is a client-side application, not an SSR application. Production
assets are built into `dist/apps/studio/` and served by the Studio server. During
development, Vite serves browser assets and proxies `/api/studio/v1` to the local
server. This follows Vite's documented
[backend integration](https://vite.dev/guide/backend-integration.html) model.

Frontend domain modules mirror user-facing concepts rather than backend folders:

```text
apps/studio/src/
  app/                 routing, shell, command palette
  api/                 typed Control API client
  workflows/           catalog, editor, canvas, inspector
  agents/              catalog and editor
  library/             registry projection
  configuration/       safe configuration projections
  runs/                catalog, detail, timeline, launch
  shared/              design primitives and accessibility helpers
  components/ui/       shadcn-owned component source
```

No workflow or capability id may be hard-coded in a component. Schema-driven
forms can have generic renderers and registered semantic renderers, but not
workflow-specific branches.

## LS-002: Server Composition Root

The Studio server lives under `src/studio/server/` and is a new Fastify
composition root. It does not register on the webhook server and does not import
provider payload implementations into generic application services.

```text
src/studio/
  server/              HTTP, local session, static assets, SSE
  contracts/           request and response DTO schemas
  application/         authoring and operation use cases
  infrastructure/      filesystem, SQLite, hashing, journals
  templates/           versioned draft generators
```

The CLI gets one generic `studio` command. It does not get commands per workflow.
The composition root loads the native platform once and injects registries and
runtime ports into application services.

## LS-003: YAML Editing Strategy

Existing YAML is source-owned. The Studio stores the original bytes and applies
explicit text edits to the smallest safe source range. Opening and saving without
an edit returns exactly the original bytes. Unedited ranges remain byte-identical.

The `yaml` package's `parseDocument` API, source node ranges, `LineCounter`, and
`keepSourceTokens` are used to locate values and retain comments. The package
explicitly distinguishes document/CST APIs from plain object parsing for source
preservation; see its [Document and CST documentation](https://eemeli.org/yaml/).
The library is a mechanism, not the guarantee: golden tests prove the observable
round-trip properties.

Structured edits use this order:

1. parse the current source and reject documents with syntax errors;
2. locate the semantic path and its exact source range;
3. render only the replacement value or collection;
4. splice that range without touching surrounding bytes;
5. reparse the result;
6. pass the result through Luna's canonical loader in the draft snapshot.

New YAML files use one canonical formatter. Reformatting an existing complete
document is an explicit action whose diff must be accepted.

JSON schemas and instruction text preserve original bytes when unchanged. JSON
structured edits use stable two-space formatting only for the edited or newly
created file.

## LS-004: Studio Presentation Metadata

Optional presentation metadata is attached to capability manifests and their
registrations. It never lives in a manually maintained frontend id list.

The initial shape is intentionally small and JSON-only:

```ts
type StudioExample = {
  title: string;
  description?: string;
  value: JsonValue;
};

type StudioFieldHintBase = {
  label?: string;
  description?: string;
};

type StudioFieldHint =
  | (StudioFieldHintBase & {
      control?: "text" | "textarea" | "number" | "json";
      placeholder?: string;
      options?: never;
    })
  | (StudioFieldHintBase & {
      control: "switch";
      placeholder?: never;
      options?: never;
    })
  | (StudioFieldHintBase & {
      control: "select";
      placeholder?: string;
      option_labels?: Readonly<Record<string, string>>;
    });

type JsonPointer = string; // Runtime-validated canonical RFC 6901 pointer.

type StudioPresentation = {
  title: string;
  summary?: string;
  category?: string;
  tags?: readonly string[];
  icon?: string;
  examples?: readonly StudioExample[];
  field_hints?: Readonly<Record<JsonPointer, StudioFieldHint>>;
};
```

Each `field_hints` key is a canonical RFC 6901 JSON Pointer into the editable
schema owned by that registration. The empty string addresses the schema root;
non-root pointers start with `/`, use `~0` and `~1` escaping, and never use a
URI fragment such as `#/properties/name`. Schema ownership is fixed:

- pattern, built-in, tool, and gate hints target `input_schema`;
- policy hints target `config_schema`;
- port hints target `option_schema`;
- artifact publisher hints target `config_schema` when it exists;
- schema registration hints target `schema`;
- a top-level capability manifest has no editable schema and therefore cannot
  declare `field_hints`.

Registration validation resolves every pointer and rejects missing or ambiguous
targets. A hint without `control` supplies copy only. Controls must agree with
the resolved JSON Schema type: `text` and `textarea` require string; `number`
requires number or integer; `switch` requires boolean; and `json` requires
object or array. `select` additionally requires a finite string domain declared
by the technical schema through `enum`, `const`, or equivalent `oneOf` branches.
The Studio derives selectable values only from that domain. Optional
`option_labels` may relabel known values but cannot add, remove, or alter them;
unknown label keys are rejected and missing labels fall back to the raw value.

The manifest or registration that owns the technical contract also owns its
presentation field; there is no second descriptor registry. Technical behavior
remains defined by the existing registration fields. Missing presentation metadata
falls back to the public id and is displayed as unknown or not applicable; it never
causes the Studio to infer side effects or retry safety. `field_hints` can select a
compatible generic control but cannot classify config exposure or override a schema.

Agent presentation is derived from validated agent files because there is no
separate public agent registry. The catalog enumerates safe directory segments and
loads every entry through `loadAgentDefinition`.

## LS-005: Draft And Change Set Format

Drafts are versioned change sets stored under:

```text
.luna/studio/drafts/<draft-id>/change-set.json
.luna/studio/drafts/<draft-id>/files/<content-hash>
```

Directories use mode `0700` and files use `0600` where supported. Large content is
content-addressed instead of embedded repeatedly in metadata.

A file reference uses a logical root and a relative path:

```ts
type StudioPath = {
  root: "project" | "config";
  path: string;
};
```

Absolute host paths never appear in public DTOs. The server resolves logical roots,
rejects traversal, and validates existing ancestors and symlinks with `realpath`.
The configured `configRoot` is a distinct root and may live outside `projectRoot`.

Every change set includes:

- schema version, draft id, optimistic version, and primary resource;
- all affected resources and explicitly allowed paths;
- base file hashes, current content hashes, and tombstones;
- dependency hashes, base bundle hash, draft hash, and catalog fingerprint;
- line-ending and mode metadata when they matter;
- local layout and validation status.

The authoritative validation snapshot is current source plus the complete change
set overlay. Loaders and compiler run against that snapshot; drafts are never
copied into active workflow or agent directories just to validate them.

## LS-006: Apply Journal And Recovery

Apply is a recoverable logical transaction, not a claim of portable filesystem
atomicity. Each apply has a durable journal under `.luna/studio/apply-journal/`
with these monotonic states:

```text
prepared -> backed_up -> installing -> verifying -> committed
                |             |             |
                +-------------+-------------+-> rolling_back -> rolled_back
                                      \
                                       +-> recovery_required
```

The apply service:

1. acquires a cross-process lock;
2. validates the confirmation token and all hashes under that lock;
3. stages content on the same filesystem as each target root;
4. syncs staged files and directories;
5. creates deterministic backups of affected paths only;
6. installs changes in deterministic order;
7. reloads and validates the installed resources;
8. syncs target directories and records `committed`;
9. removes staging and backups only after the commit record is durable.

Unknown files outside the change set are never replaced. A startup recovery pass
finishes verification or records `rolling_back` before restoring backups and then
records `rolled_back`. Any state may move to `recovery_required` when the durable
evidence is ambiguous. Cleanup is retryable after either terminal state. An
ambiguous failure is never reported as success.

`plan-apply` returns a short-lived opaque token bound to the draft version and
hash, base/dependency hashes, catalog fingerprint, compiler contract version, and
the exact diff. `apply` also requires `If-Match` and an idempotency key.

## LS-007: Control API Boundary

The API prefix is `/api/studio/v1`. Request and response bodies are validated by
schemas under `src/studio/contracts/`. DTOs may contain resource ids, logical
paths, projections, and opaque handles; they must not expose loader objects,
filesystem roots, backend URIs, stack traces, environment variables, or secrets.

Errors use one envelope:

```json
{
  "error": {
    "code": "source_conflict",
    "message": "The source changed after the draft was opened.",
    "details": {},
    "request_id": "request-id"
  }
}
```

All mutations are commands with optimistic concurrency. Destructive or externally
side-effecting commands also use idempotency keys. There is no arbitrary file,
shell, Git, or environment endpoint.

## LS-008: Local Session And Browser Security

Local mode has no user identity, login form, or RBAC. It still uses a startup
capability to protect the Control API from unrelated sites and accidental local
clients. Every API route except health, static assets, and the one-time session
exchange requires a valid session; CSRF is an additional requirement for mutations.

The CLI generates a random startup capability and prints a launch URL containing
it in the fragment. The browser exchanges the capability through a dedicated JSON
request, immediately removes the fragment, and receives:

- an opaque, `HttpOnly`, `SameSite=Strict` session cookie;
- an anti-CSRF value returned in the JSON body and kept in memory;
- a short server-side session expiry.

Mutation requests require the session cookie, the anti-CSRF header, JSON content
type, and an allowed `Origin`. All routes validate `Host`; Fastify documents that
host and forwarding metadata are untrusted and require explicit validation in
security-sensitive decisions. CORS is closed and `trustProxy` stays disabled.

The default bind is `127.0.0.1`. A non-loopback bind requires both an explicit CLI
flag and a configured non-local identity provider; local capability mode is not
accepted for remote exposure. The server emits a restrictive CSP, frame denial,
MIME sniffing protection, referrer policy, and request/body limits.

## LS-009: Run Ledger, Events, And Catalog

Run state uses the built-in `node:sqlite` backend already used by Luna. A single
SQLite database may implement the local deployment, but the code exposes separate
ports:

- `RunLedgerPort`: canonical CAS/idempotent run transitions;
- `RunEventLedgerPort`: ordered cursor events;
- `RunCatalogPort`: filtered, paginated projections;
- `ArtifactReaderPort`: bounded content access through opaque handles.

The schema is versioned and migrated transactionally. WAL mode supports local
read/write concurrency. The ledger owns dispatch state, runtime state, heartbeat,
ownership, snapshot hashes, subject/repository projections, effects, and terminal
failure. A single transactional command appends the canonical transition and its
ordered lifecycle event/outbox record in the same SQLite transaction. The logical
ports remain separate for queries, but application code cannot persist a transition
and event as unrelated writes. The catalog projector consumes the committed outbox
and is rebuilt from the ledger; it is never the authority for a transition.

Runtime events are projected into the event ledger at their production boundary.
Existing checkpoint, observability, and summary files remain specialized stores
and are not reinterpreted as a complete lifecycle.

## LS-010: Run Plan, Confirmation, And Dispatch

Real execution is a three-step application flow:

1. resolve invocation, route, config, repository, definition bundle, and catalog;
2. persist a short-lived `RunPlan` and return effects plus a confirmation token;
3. consume the token and idempotency key, preallocate `run_id`, persist `queued`,
   and dispatch outside the request lifecycle.

The confirmation token binds all hashes and the resolved effect plan. Execute
recomputes mutable inputs and rejects a stale plan. Normal artifacts, logs,
checkpoints, and traces do not require a separate confirmation; repository mutation
and declared external writes do.

The dispatcher records an owner and heartbeat. Startup reconciliation marks stale
active work as orphaned or requeues only when policy proves replay safety. A queued
response is HTTP 202 and always includes the preallocated run id.

Adapters remain normalizers. Launch accepts either normalized invocation JSON or a
registered adapter plus its current opaque string input. Deterministic routing
selects a workflow unless the caller explicitly pins a workflow target.

The Workflow Studio presents this relationship on an **Inputs and routing** panel,
but does not write adapter ownership into `workflow.yaml`. The panel can execute a
registered adapter preview and show the resulting normalized Invocation. Routing
rules evaluate only `{ invocation }`; an adapter id is not persisted as a predicate
because it is not part of the Invocation contract. Rules may use normalized fields
such as `source`, `event`, `action`, subject, or repository, so they cannot
distinguish two adapters that intentionally produce the same envelope.

The edited `RouterDefinition` is a separate config-root resource in the same
multi-resource draft. Its location comes from the canonical config loader:
`LUNA_CONFIG_ROOT` selects the root and `app.routing.path ?? "routing.yaml"`
selects the relative file. The panel calls the canonical router for simulation and
never duplicates predicates in frontend code. This lets one workflow accept
GitHub, Jira, Plane, webhook, CLI, or manual invocations without coupling its graph
to any provider.

## LS-011: Visual Layout

Layout is stored at `.luna/studio/layouts/workflows/<id>.json` and is never inserted
into strict workflow YAML. Missing layout uses a deterministic topological layout.
Graph semantics come only from workflow `after`; dotted data-reference overlays are
derived from expressions.

The canvas and outline consume one graph view model. A pattern may have a conceptual
expanded view, but the compiled graph still contains one pattern node.

## LS-012: Templates

Templates are versioned generators registered under `src/studio/templates/`. A
template produces an ordinary multi-resource draft, then runs the same validation
pipeline as imported or manually created content. It cannot execute and is not a
second workflow format.

Instantiation resolves ids, reports collisions, rewrites references in the draft,
and exposes every generated file and possible side effect. Updating a template does
not mutate existing instances.

## LS-013: Project Scope

One Studio server process owns one `projectRoot` and one resolved `configRoot`.
Multi-project navigation is postponed to the scale phase and will compose several
isolated project services rather than making every current service optionally
multi-root.

The initial repository configuration surface is read-only. Editing a target
repository is enabled only after the server is given explicit allowed repository
roots and validates resolved paths against them.

## LS-014: Authorization And Collaboration

Application commands receive a `Principal`, `AuthorizationPort`, and `AuditLogPort`
from the beginning. Local mode supplies a synthetic `local-user` principal and a
local authorization policy. Loaders, compiler, workflows, and capability executors
never import identity or RBAC concepts.

Remote mode later supplies an identity provider, project/repository role bindings,
and durable audit. It is impossible to enable a non-loopback listener without that
mode. Human decisions use atomic claims and record actor, decision schema version,
input hash, and timestamps.

## LS-015: Verification Strategy

Tests are split by authority:

- unit tests for DTOs, source edits, hashes, descriptors, projections, and policies;
- golden tests for byte preservation and deterministic generated files;
- integration tests for draft/validate/compile/plan/apply/recover;
- HTTP security tests for Host, Origin, session, CSRF, content type, and limits;
- integration tests for run transitions, cursor pagination, artifacts, and launch;
- browser tests for primary keyboard flows, canvas/outline parity, and unsafe HTML;
- compatibility tests that load every existing workflow and agent through Studio
  catalogs without changing their runtime semantics.

The browser may provide fast local feedback, but apply and run commands always call
server-side canonical validation. A passing frontend form is never evidence that a
workflow is valid.

## Resolved Product Questions

- The first deployment opens one project root.
- Templates are bundled code registrations that generate ordinary drafts.
- Global provider/plugin/runtime configuration is read-only until governed remote
  administration exists; classified workflow config can be edited earlier.
- Launch supports invocation JSON and the existing opaque adapter string contract.
- Layout is local in the first deployment.
- Apply can create new resource directories through a draft.
- Initial Git integration is status and diff only. The Studio never commits or
  pushes authoring changes automatically.

## Dependency Direction

```text
browser DTOs
    -> Studio HTTP handlers
    -> Studio application ports/use cases
    -> Luna loaders, registries, compiler, router, runtime ports
    -> filesystem / SQLite / native platform adapters
```

Dependencies must never point from `src/core/**` into `src/studio/**`. Only run
contracts that are genuinely runtime-wide belong under `src/core/runtime/runs/**`;
browser shapes remain Studio DTOs.
