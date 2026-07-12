# Luna Studio Architecture Decisions

This document records the implementation decisions that turn the Luna Studio
product specification into code. It is intentionally narrower than the product
plan: it fixes ownership, persistence, packaging, and security boundaries that
implementations must follow.

The Studio remains a projection over Luna's existing files, loaders, registries,
compiler, and runtime. It is not a second workflow engine.

The local loopback control plane and capability-session boundary described here
are implemented. Remote identity, RBAC, durable actor audit, multi-user
collaboration, and non-loopback exposure remain later-phase work. For the
user-visible surface and its current limits, see the
[Luna Studio operational guide](studio-guide.md).

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
and the current registry was initially generated with the documented
[`shadcn add --all`](https://ui.shadcn.com/docs/cli) command. `components.json`
records the selected Base UI preset and aliases. Generation is a discovery and
scaffolding step, not a permanent dead-code exemption: after the Studio surfaces
were composed, unreachable generated components and their exclusive dependencies
were removed. `knip.json` starts at `src/main.tsx`, so retained `components/ui`
files must remain reachable through normal application imports and pass the same
unused-code gate as first-party modules.

“All components” means all registry components available from the pinned shadcn
CLI were evaluated during initial generation, including the current conversation
primitives. Only the components the product actually uses are committed. Future
upstream additions are deliberate source updates, never nondeterministic
build-time downloads.

React Flow was selected because its public contract includes keyboard-focusable
nodes and edges, selection and movement by keyboard, ARIA descriptions, and live
announcements. These features help, but do not replace the outline required by
the Studio acceptance criteria. See the
[React Flow accessibility guide](https://reactflow.dev/learn/advanced-use/accessibility).

The application is a client-side application, not an SSR application. Production
assets are built into `apps/studio/dist/` and served by the Studio server. During
development, Vite serves browser assets and proxies `/api/studio/v1` to the local
server. This follows Vite's documented
[backend integration](https://vite.dev/guide/backend-integration.html) model.

Frontend domain modules mirror user-facing concepts rather than backend folders:

```text
apps/studio/src/
  app/                  bootstrap, routing, session and editor state
  api/                  typed Control API client split by domain
  pages/                route-level compositions
  features/workflows/   editor, graph, schemas, diff, apply and run projection
  features/agents/      structured editor, Test Bench and resource authority
  features/drafts/      local draft file sessions
  features/configuration/ classified config and redacted posture
  features/launch/      adapter/invocation input and plan-confirm-execute
  features/runs/        graph, timeline, logs and semantic artifact views
  features/history/     Git compare and restore-as-draft
  components/           shell and shared page components
  components/ui/        shadcn-owned component source
  hooks/, lib/, test/    browser helpers and test setup
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
  server/               composition, HTTP, security, static assets and routes
  contracts/            request and response DTO schemas
  application/          authoring, drafts, validation, apply, configuration,
                        inputs, routing, launch, runs, history and sandbox use cases
  adapters/filesystem/  private storage, locks, journals, graphs, logs and artifacts
  adapters/git/         bounded resource history and comparison
  adapters/memory/      local confirmation and plan-token stores
  adapters/native/      Luna loaders, compiler, runtime and repository bridges
  adapters/redaction/   safe text projection
  adapters/sqlite/      durable run ledger, events and catalog
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
      control?: never;
      placeholder?: never;
      option_labels?: never;
    })
  | (StudioFieldHintBase & {
      control: "text" | "textarea" | "number" | "json";
      placeholder?: string;
      option_labels?: never;
    })
  | (StudioFieldHintBase & {
      control: "switch";
      placeholder?: never;
      option_labels?: never;
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

User-visible presentation strings are nonblank, except that an explicitly empty
`placeholder` is allowed. A hint without `control` carries only label and
description copy.

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
when present, its keys must cover that domain exactly.

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
content-addressed instead of embedded repeatedly in metadata. Blobs are not an
independent persistence API: `create` and `update` receive the change set and its
new blobs as one locked mutation. The repository rejects duplicate, mismatched,
or unreferenced blobs before writing anything. A configurable aggregate quota
limits the entire drafts store in addition to per-file limits; the first locked
access after startup removes incomplete creates, atomic-write remnants, and blobs
not referenced by durable metadata.

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

- schema version, draft id, optimistic revisions, and primary resource;
- all affected resources and explicitly allowed paths;
- base file hashes and modes, current content hashes, and tombstones;
- dependency hashes, base bundle hash, draft hash, and separate technical and
  presentation catalog fingerprints;
- line-ending and mode metadata when they matter;
- local layout and validation status.

`record_revision` is the monotonic optimistic concurrency version for every
persisted draft mutation, including validation-status-only updates.
`content_revision` advances only when applicable content changes, while
`layout_revision` advances only for editor layout changes. `draft_hash` remains
the identity of applicable technical content and intentionally excludes status,
layout, and persistence-only revisions. Each revision advances if and only if its
corresponding semantics changed; builders and repository validation both reject
no-op updates and revision-only updates.

Draft enumeration is a stable, bounded page over storage entries. It reads only
`change-set.json`, never blob bodies, and returns a sanitized diagnostic beside
each unreadable draft rather than failing the entire page.

Delete has its own filesystem commit protocol. Under the drafts lock, the live
directory is renamed to a versioned hidden tombstone and the drafts directory is
synced. Any failure after rename is reported as `commit_ambiguous`; retrying with
the same expected revisions recognizes the tombstone as the same logical delete.
Tombstones remain hidden for a configurable retry window and are garbage-collected
after expiry on a later locked access. Even when no local tombstone is known, each
repository instance performs a bounded periodic rescan under the shared lock so it
discovers crash remnants and tombstones created by another process. A reused draft
id is rejected while its tombstone exists.

Releasing the cross-process lock is cleanup after the protected operation has
already produced its authoritative outcome. A release failure is sent without
waiting to an audit-only callback whose rejection is absorbed; it never turns a
durably committed create, update, or delete into an apparent failure. Later
operations may still time out until stale-lock recovery succeeds.

`technical_catalog_fingerprint` binds compilation/apply authority and is included
in `draft_hash`. `presentation_catalog_fingerprint` detects stale labels, examples,
field hints, and other UX projections; it does not invalidate otherwise identical
technical content or authorize apply.

The authoritative validation snapshot is current source plus the complete change
set overlay. Loaders and compiler run against that snapshot; drafts are never
copied into active workflow or agent directories just to validate them.

Authoring closure changes are lossless. If editing a canonical reference would
remove an allowed file that still has a pending draft change, the whole mutation
is rejected as a conflict before metadata or blobs are persisted. The response
contains a deterministic, bounded list of affected logical paths. The operator
must first restore, apply, or explicitly remove those edits; recalculating a
closure never garbage-collects dirty content implicitly.

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
4. sets file modes through open descriptors, then syncs staged files and every
   newly created directory entry through its parent directory;
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
hash, base/dependency hashes, technical catalog fingerprint, compiler contract
version, and the exact diff. `apply` also requires `If-Match` and an idempotency
key.

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

The default bind is `127.0.0.1`. Local container mode may use an explicit CLI flag
for a wildcard transport bind only when a separate public authority remains an
explicit loopback IP and the host port is published on loopback. Any non-loopback
public authority requires a configured non-local identity provider; local
capability mode is not accepted for remote exposure. The server emits a restrictive
CSP, frame denial, MIME sniffing protection, referrer policy, and request/body
limits.

The local filesystem trust boundary is the operating-system principal that owns
the project and Studio private roots. Portable Node.js pathname APIs do not expose
an `openat`/directory-handle transaction for every rename and recursive removal,
so a hostile process running as that same principal and concurrently replacing a
protected root directory is outside local mode's guarantee. Inside that boundary,
Studio directories are private, leaf reads reject symlinks, maintenance first
renames entries to unpredictable same-directory quarantine names and verifies
their file identity, and validation reads pin an open handle and compare its
identity before and after reading. Remote or mutually untrusted filesystem access
requires a different storage backend and identity threat model.

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

The SQLite file is not stored inside the repository. Local mode derives a
project-scoped directory below `LUNA_STUDIO_STATE_ROOT` or the user's XDG state
root. Compose requires a stable host-checkout identity, uses it in the Compose
project namespace, and hashes it into a private subdirectory of the named state
volume. The inner namespace is intentional defense in depth: two checkout
identities remain separate even when an override shares one physical volume.
The database leaf is opened only after no-follow regular-file identity checks,
so a checkout cannot redirect SQLite through a pre-existing symlink.

Runtime events are projected into the event ledger at their production boundary.
Existing checkpoint, observability, and summary files remain specialized stores
and are not reinterpreted as a complete lifecycle.

Run-log pagination captures one immutable in-memory snapshot while computing its
keyed fingerprint and verifies source file identity again after the read. Cursor
continuations page only that snapshot, so source I/O is linear in snapshot size
instead of repeated per page. The process-local LRU is bounded by aggregate
bytes, entry count, and TTL; missing, expired, or evicted snapshots return cursor
expiry and never fall back to a changed source file.

The canonical run record also stores the accepted Studio plan id and a bounded,
safe input provenance projection. Invocation launches store only the provenance
kind; adapter launches additionally store the registered adapter id and a digest
of the opaque adapter input. The opaque input itself is not copied into the run
ledger. This makes an `acceptance_unknown` response recoverable through an exact
plan-id catalog lookup without replaying the one-shot confirmation request.

Subject URLs are treated as untrusted display metadata. User-info credentials,
known secret query parameters (including AWS, GCS, and Azure signed-URL forms),
encoded key names, and credential-bearing fragments are rejected at the contract
boundary. The shared redactor applies the same classification to diagnostic text,
so a signed URL cannot become searchable provenance or leak through an error.

Terminal node outputs have a separate explicit-read projection. The persisted
outcome owns the bounded, best-effort-redacted snapshot and its graph/outcome
hashes. Output comparison reuses two such immutable projections and computes a
bounded structural diff on demand; it never persists a comparison copy, reads a
live runtime state, or extends the retention lifetime of either source run.

Runs created outside Studio, such as CLI and webhook executions, are reconciled
from the shared artifact root by a bounded background importer. The importer is
not on the request path, advances a bounded in-process cursor across batches,
retries temporarily incomplete entries with bounded backoff, rejects links and
path escapes, and projects only canonical historical metadata into the same
catalog. Imported records use immutable `historical_unknown` dispatch state,
unknown lifecycle projection, and unavailable counts/duration rather than fake
terminal facts. Imported metadata is observational: it cannot synthesize
dispatch ownership or rewrite a live Studio lifecycle.

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

If an acceptance response is lost, the one-use token is not replayed. The client
plans and confirms again with the same idempotency key. When actor binding and
execution snapshot are exact, native dispatch adopts the immutable job and run
accepted by the first plan, returns a receipt bound to the new plan, and keeps the
original accepted plan in the ledger for audit. A changed snapshot or actor never
adopts that run.

Effect classification is declarative. Each side-effect policy registration may
publish a validated category such as `provider_read`, `local_process`,
`repository_write`, or `external_write`; Studio resolves the launch plan from
that manifest metadata and never from capability-id prefixes. An unclassified
write remains conservatively visible as an external write.

The dispatcher records an owner and heartbeat. Every acquired lease also creates
a fresh cryptographic acquisition token used in mutable heartbeat and terminal
transition ids, so two recoveries by the same worker owner cannot collide when
their local counters restart. Deterministic recovery-claim and outcome-proof ids
remain content-addressed for idempotent replay. Startup reconciliation marks stale
active work as orphaned or requeues only when policy proves replay safety. A queued
response is HTTP 202 and always includes the preallocated run id.

Replay authorization is evidence-based. A stale job may receive a durable recovery
intent only when immutable preflight evidence proves the complete plan is read-only
and contains no unlisted write. Recovery claims the exact intent hash and execution
identity atomically before replay. A started write-capable job, an unknown
checkpoint acceptance, a missing/mismatched intent, or any contradictory evidence
becomes `outcome_unknown`; its workspace and artifacts are retained for manual
review and the dispatcher never automatically executes it again.

Before any runtime node executes, the checkpoint store binds `run_id` to the
compiled workflow id and revision. Node output/completion checkpoints are also
namespaced by that immutable identity. An exact retry of the same revision may
reuse durable completion, while a reused `run_id` for a changed workflow or agent
fails before a side effect instead of accepting stale output.

Legacy waiting runs without that identity are migrated only during resume. Luna
first validates the exact waiting checkpoint, schema, workflow revision, resume
context, deterministic checkpoint id, and matching interrupt without writing;
only that durable evidence may establish the missing identity. A mistyped or
changed-revision resume therefore cannot poison the later valid resume.

Repository launch fingerprints use one global deadline and strict aggregate
budgets for tracked differences and untracked content. Reads reject special files,
pin regular-file/symlink identity before and after hashing, disable external Git
diff helpers, and never open an untracked FIFO or device. A timeout, mutation, or
unsupported entry fails planning/dispatch closed.

Runtime success crosses an explicit durability barrier. After final output
validation, the Studio first writes an exact terminal intent and replays it into
the graph outcome and run ledger. Only then may Luna write its secondary
succeeded checkpoint. Terminalization never performs workspace cleanup after
either success or failure. An exact journal resolves
acceptance-unknown replay errors, startup recovery completes any remaining
projection, and no secondary store may reclassify the authoritative terminal.

Luna retains all run workspaces for Studio and CLI executions. Automatic
worktree deletion is deferred until cleanup has its own durable, observable,
retry-safe operation. A later Studio cleanup action must be separately planned
and confirmed, idempotent, recoverable from a durable intent, and reflected as
operational workspace state; it must not silently reuse terminalization or
failure recovery.

Adapters remain normalizers. Launch accepts either normalized invocation JSON or a
registered adapter plus its current opaque string input. Deterministic routing
selects a workflow unless the caller explicitly pins a workflow target.

The implemented UI presents this relationship through the **Routing** and **Input
adapters** tabs in Configuration and through adapter preview in Launch. It does
not write adapter ownership into `workflow.yaml`. Launch can execute a registered
adapter preview and show the resulting normalized Invocation. Routing rules
evaluate only `{ invocation }`; an adapter id is not persisted as a predicate
because it is not part of the Invocation contract. Rules may use normalized
fields such as `source`, `event`, `action`, subject, or repository, so they cannot
distinguish two adapters that intentionally produce the same envelope.

For example, the Studio may author the equivalent routing rule outside the
workflow:

```yaml
- id: github-pull-request-review
  when:
    expression: >-
      $.invocation.source = "github" and
      $.invocation.event = "pull_request"
  target: workflow:code-review
```

This means “an Invocation normalized as GitHub pull request runs code-review”,
not “the workflow belongs to the GitHub adapter”. If future routing must
distinguish two physical adapters that emit the same normalized envelope, the
trusted Invocation contract must first gain an explicit adapter-origin field;
the Studio must not infer one from browser input.

The current Studio loads `RouterDefinition` from the canonical config loader and
exposes a read-only projection plus simulation; it does not edit `routing.yaml`.
`LUNA_CONFIG_ROOT` selects the root and
`app.routing.path ?? "routing.yaml"` selects the relative file. Simulation calls
the canonical router and never duplicates predicates in frontend code. A future
authoring surface must treat the router definition as a separate config-root
resource in a multi-resource draft. This lets one workflow accept GitHub, Jira,
Plane, webhook, CLI, or manual invocations without coupling its graph to any
provider.

## LS-011: Visual Layout

Layout is stored in the draft's non-semantic `layout` field under private
`.luna/studio/drafts/` state and is never inserted into strict workflow YAML.
Missing layout uses a deterministic topological layout. Graph semantics come only
from workflow `after`; the current canvas does not invent additional semantic
edges from expressions.

The canvas and outline consume one graph view model. A pattern may have a conceptual
expanded view, but the compiled graph still contains one pattern node.

## LS-012: Templates

Templates are versioned generators registered by
`src/studio/application/drafts/authoring-template-catalog.ts`, with parameter and
workflow builders in the neighboring `authoring-template-*.ts` modules. A
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

Current local mode uses a transport-owned `StudioLocalPrincipal` derived from the
loopback capability session. It gates mutation availability at the Control API
boundary; there is no general `AuthorizationPort`, role model, or durable
`AuditLogPort` yet. Loaders, compiler, workflows, and capability executors do not
import identity or RBAC concepts.

Remote mode must introduce command-level principals, an authorization port,
project/repository role bindings, and durable actor audit before it can supply a
non-loopback public authority. Container-local mode has one narrow transport exception: an
explicit opt-in may bind the process to a wildcard inside a container bridge while
the launch URL, Host allowlist, Origin allowlist, and published host port remain on
an explicit loopback IP. This exception is not remote mode and must never publish
the port on all host interfaces. Human decisions use atomic claims and record actor,
decision schema version, input hash, and timestamps.

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
- Global provider/plugin/runtime/repository configuration is exposed only through
  redacted read-only projections; classified workflow config is editable through
  its own draft/validate/plan/apply flow.
- Launch supports invocation JSON and the existing opaque adapter string contract.
- Layout is local in the first deployment.
- Apply can create new resource directories through a draft.
- Git integration lists reachable revisions for workflow and agent bundles,
  compares selected revisions, and restores a revision as an ordinary draft. It
  never updates refs, checks out files, commits, or pushes authoring changes
  automatically.

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
