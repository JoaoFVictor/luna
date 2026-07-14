# Capabilities, Tools, And Runtime

Luna exposes deterministic workflow and agent behavior through capability
manifests. Runtime composition then wires those registrations to concrete
ports, backends, and runtimes.

## Capabilities

Capability manifests live under `src/capabilities/<id>/manifest.ts` and are
assembled by `src/capabilities/registry.ts`.

A manifest can register:

- built-ins
- patterns
- gates
- local tools
- ports
- artifact publishers
- schemas
- side-effect policies
- intrinsic workflow-node ownership (`workflow_node_types`; currently `agent`)
- re-exports and dependencies

The core registry validates duplicate ids, dependency order, unresolved
references, undeclared cross-capability references, policy metadata, and write
side-effect operation ids. A workflow node type may have only one declared
capability owner. Registered node kinds derive their owner from the selected
registration; agent nodes derive it from this manifest declaration.

Add public deterministic behavior in a capability, not as an unregistered
helper and not as a scattered public name list.

## Built-Ins

Built-ins are deterministic workflow nodes. They are referenced by `uses:` in
workflow YAML and registered through capability manifests plus native platform
executors.

Built-in metadata can express runtime behavior such as:

- repository requirement.
- exclusive repository locks.
- workspace capture.
- lifecycle phase.
- deferred final report.

Runner behavior should come from metadata, policies, and manifests, not ad hoc
string checks.

Common built-in families:

- `runtime.preflight`
- `context.collect_context`
- `repository-diff.collect_context`
- `repository-context.related_context`
- `repository-workspace.capture`
- `review.coverage_plan`
- `review.coverage_check`
- `review.quality_check`
- `task-context.collect` and `task-context.final_report`
- `validation.repository_configuration`
- `validation.run_commands`
- `findings.merge`
- `findings.validate_evidence`
- `reports.final_report`
- `local-exec.command.read` and `local-exec.command.write`
- `git.status`, `git.commit`, `git.push_branch`
- `change-request.create`
- `pull-request-review.publish`
- `repository-change.*` lifecycle steps

For the exact current set, inspect `src/capabilities/*/manifest.ts` and
`src/capabilities/registry.ts`.

Provider-backed publishing built-ins still live in provider-neutral
capabilities. `pull-request-review.publish` turns validated findings and PR
diff context into a formal review request, and can render a structured
acceptance result into the PR body. The selected provider port owns the
external API call. The built-in resolves the effective review event from the
validated finding state and optional acceptance result before the provider is
called, so provider modules do not own review policy. It also applies
provider-neutral comment noise control: primary-evidence inline placement,
duplicate comment removal, inline comment caps, and fallback body comments for
secondary or unplaceable evidence. `change-request.create` follows the same
split for change requests.

`review.coverage_plan`, `review.coverage_check`, and `review.quality_check` are
provider-neutral review quality built-ins. The plan extracts
`expected_review_ranges` from repository diff context and records blocked
coverage for omitted, truncated, binary, deleted, or uncaptured changes. The
check compares those ranges against reviewer-reported `reviewed_ranges` and
returns `missing_review_ranges` so reports and acceptance can distinguish
complete, partial, and blocked review scope. Reviewer ranges may carry `notes`
and `risk_tags`, which gives acceptance stronger evidence than a bare range
declaration. The quality check then combines coverage, related-context audit
signals, truncation, and publishable finding evidence into a deterministic
`pass`, `needs_human_review`, or `blocked` status. Coverage is still an
auditable reviewer declaration checked against captured diff evidence; it is
not treated as proof that a model semantically understood every changed line.

`repository-context.related_context` is the provider-neutral impact-context
built-in shared by code review and implementation. It accepts exactly one
source: captured `repo_context`, normalized task text, or an attempt-scoped
worktree diff. It emits `luna.repository_context.v2` with source, snapshot, and
coverage identity plus ranked files and graph `nodes` and `edges`. Discovery
comes from the deterministic repository index; agent-local file listing and
text search are not alternate discovery paths. Inventory is the repository's
tracked files plus non-ignored untracked files, as reported by Git, and
changed-file excerpts are centered on captured diff hunks instead of blindly
taking the file prefix. It builds one
internal Luna symbol graph before ranking context. The graph is SCIP-inspired
but is not a real `.scip` protobuf index: occurrences use Luna symbol strings,
SCIP-compatible `symbol_roles` bitsets, typed UTF-16 ranges, and document-local
symbol metadata. Engines use TypeScript for JS/TS, Luna-owned
`@vue/compiler-sfc` for Vue SFC script/template extraction, and
Luna-owned `nikic/php-parser` from the runtime image for PHP; target-repository
dependencies are never used to supply the parser. After import resolution,
Luna links references back to resolved definition symbols before scoring reverse
references. Ranking is deterministic and repository-neutral: Unicode-aware
camel/snake/kebab tokenization feeds field-weighted BM25/IDF over paths, symbols,
and content; conservative morphology and one-edit matching cover minor lexical
variation. Files selected only by this retrieval are labeled `query_match` with
source `lexical_retrieval`. Import/include and linked-symbol edges expand from
diversified seeds for up to three decayed hops, and the public graph emits edges
between all selected endpoints. If a parser is unavailable or fails,
the built-in keeps producing deterministic context through heuristics and
records that in `audit.warnings`. The output also records
`audit.symbol_engines`, so agents and humans can see whether a run used
`typescript_symbol_graph`, `vue_sfc_symbol_graph`, `php_symbol_graph`,
`php_heuristic`, or generic `heuristic`. It resolves
relative imports, TypeScript/JavaScript `paths` aliases and `baseUrl` from
`tsconfig.json` or `jsconfig.json` (with no undeclared root-alias fallback),
PHP `require`/`include`, Composer PSR-4 namespaces, reverse references,
tests/specs, config files, docs, same-directory files, and same-name
abstractions. Docs/config edges are emitted only when they match the specific
changed seed, not as global edges to every changed file. Budgets and truncation
are part of the output so agents and humans can see when context was limited:
`truncation.omitted_paths` lists ranked candidates excluded by
`max_related_files` up to a bounded sample, `omitted_count` records the full
excluded count, and `truncated_paths` lists excerpts clipped by file or excerpt
budgets.

`findings.merge` is the deterministic fan-in for multi-agent review outputs. It
accepts a `sources` array of named entries shaped as
`{ id, result: { findings, reviewed_ranges } }`, computes provider-neutral
fingerprints, preserves source provenance, keeps the stronger
severity/confidence when duplicate findings match, unions evidence and reviewed
ranges, and returns the same `{ summary, findings, reviewed_ranges }` shape
consumed by downstream review checks. The shared reviewer output schema is
registered as `findings.review_output` so reviewer agents do not need
copy-pasted local JSON schemas.

## Local Tools

Local tools are not workflow nodes. They are functions an agent can call during
a model session.

Repository tools are registered by the `repository` capability. Current ids
include:

- `repository.status`
- `repository.diff-summary`
- `repository.read-file`
- `repository.write-file`
- `repository.delete-file`

The `repository-context` capability separately registers
`repository-context.query`. It accepts bounded text, path, and symbol hints and
returns `luna.repository_context_query.v1` from the same canonical,
snapshot-aware index and ranking pipeline used by the workflow built-in. Agents
use it only to narrow a concrete gap in the initial graph. Agent calls are
automatically pinned to that graph's snapshot and reject drift; direct callers
can provide `expected_snapshot_id`. It does not expose a raw file-list or
text-search path.

`status`, `diff-summary`, and `read-file` are available to read-only and trusted
write agents. Repository discovery is workflow-owned and comes from the
`repository-context` capability rather than ad-hoc agent tools. `write-file`
and `delete-file` are trusted-local-write tools. Tool resolution checks
capability registration, protocol, contract, requested ids, and agent mode.

Tool implementations are bound to a cwd and must keep filesystem access inside
that cwd. After a workflow promotes an isolated workspace, both ordinary agent
nodes and pattern agents bind their local tools to that workspace rather than
the repository default.

## MCP Status

MCP policy and schemas exist in config/tool resolution. Resolving MCP tools
adds runtime requirements such as `mcp_tools`.

The bundled Pi adapter currently advertises only local tool support. Do not
document MCP tool execution as working with Pi until the runtime adapter
materializes MCP tools.

## Local Exec And Validation

`local-exec.command.read` and `local-exec.command.write` run host commands
through a process runner using `spawn(cmd, args)` with no shell. Read-only
workflows cannot use write operations. Large outputs can be written as
artifacts.

`validation.repository_configuration` returns the selected repository's
validation contract when present and an empty command list when absent.
`validation.run_commands` uses an explicit command list and passes only when
every configured command exits 0 and does not time out. An empty list runs no
validation process and passes. Validation commands do not inherit
the Luna process environment: the runner preserves `PATH`, creates an isolated
temporary `HOME`, then adds only variables named by the repository's explicit
environment allowlist. Missing allowlisted variables are omitted. Declared
executables must exist in the execution environment; Luna does not install or
infer repository toolchains.

These features run on the host and must be treated as trusted host-local
execution. Environment sanitization limits accidental credential propagation;
it is not an operating-system filesystem or network sandbox.

## Runtime Composition

Runtime composition lives in `src/runtime/composition/**`. It selects:

- artifact, event, interrupt, checkpoint, and runtime-log backends.
- workflow runtime factory.
- agent runtime factory.
- interrupt authorization policy.
- capability ports.
- artifact publisher and observability sinks.

Default app config uses filesystem stores for artifacts/events/interrupts/logs,
SQLite checkpoints, LangGraph workflow runtime, and Pi agent runtime.

Memory backends exist for tests and non-durable runs. Durable checkpointing is
required for resumable human interrupts in real runs.

## Pi Agent Runtime

The Pi adapter lives in `src/agent-runtimes/pi/**`.

It owns:

- model profile projection.
- Pi auth bridge.
- agent session execution.
- local tool materialization.
- model-facing tool name conversion.
- tool call loop limits.
- usage/log bridging.
- JSON final-output parsing.

It currently supports:

- tool protocol: `local`.
- runtime requirement: `tool_calling`.

It does not own workflow routing, provider auth, provider payload parsing, or
generic capability contracts.

## Trusted Write Mechanics

Trusted write workflows combine several layers:

- workflow mode: `trusted_local_write`.
- trusted write agent mode.
- repository tools allowed only in write mode.
- `quality-gates.gated_agent_loop`.
- validation and review gates.
- `human_gate` approval.
- deterministic git commit/push/change-request built-ins.
- side-effect policies and lifecycle records.

Agents edit the prepared worktree. Deterministic built-ins commit, push, and
open change requests after gates approve.

Trusted host-local execution can access local filesystem, credentials, network,
and CLIs. Keep that warning visible in reports and docs.

## Source Map

- Capability manifest type: `src/core/capabilities/manifest.ts`
- Capability registry: `src/core/capabilities/registry.ts`
- Official capabilities: `src/capabilities/registry.ts`
- Built-in contracts: `src/core/built-ins/types.ts`
- Built-in registry mechanics: `src/core/built-ins/registry.ts`
- Tool resolution: `src/core/tools/resolved-catalog.ts`
- Repository tools: `src/capabilities/repository/**`
- Local exec: `src/capabilities/local-exec/**`
- Validation runner: `src/capabilities/validation/**`
- Runtime composition: `src/runtime/composition/**`
- Runtime backends: `src/runtime/backends/**`
- Workflow runtime adapter: `src/runtime/langgraph/**`
- Pi adapter: `src/agent-runtimes/pi/**`
