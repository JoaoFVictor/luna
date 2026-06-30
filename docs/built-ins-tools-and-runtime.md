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
- re-exports and dependencies

The core registry validates duplicate ids, dependency order, unresolved
references, undeclared cross-capability references, policy metadata, and write
side-effect operation ids.

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
built-in used by code review. It takes captured `repo_context`, scans a bounded
set of supported repository files, and emits `luna.related_context.v1` with
ranked files plus graph `nodes` and `edges`. It skips dependency/build output
and local agent/editor tool directories, and changed-file excerpts are centered
on captured diff hunks instead of blindly taking the file prefix. It builds one
internal Luna symbol graph before ranking context. The graph is SCIP-inspired
but is not a real `.scip` protobuf index: occurrences use Luna symbol strings,
SCIP-compatible `symbol_roles` bitsets, typed UTF-16 ranges, and document-local
symbol metadata. Engines use TypeScript for JS/TS, Luna-owned
`@vue/compiler-sfc` for Vue SFC script/template extraction, and
`nikic/php-parser` through the target repository's autoload when available for
PHP. After import resolution, Luna links references back to resolved definition
symbols before scoring reverse references. If a parser is unavailable or fails,
the built-in keeps producing deterministic context through heuristics and
records that in `audit.warnings`. The output also records
`audit.symbol_engines`, so agents and humans can see whether a run used
`typescript_symbol_graph`, `vue_sfc_symbol_graph`, `php_symbol_graph`,
`php_heuristic`, or generic `heuristic`. It resolves
relative imports, TypeScript/JavaScript `paths` aliases and `baseUrl` from
`tsconfig.json` or `jsconfig.json`, common root aliases such as `@/` and `~/`,
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

`status`, `diff-summary`, and `read-file` are available to read-only and
trusted write agents. `write-file` and `delete-file` are trusted-local-write
tools. Tool resolution checks capability registration, protocol, contract,
requested ids, and agent mode.

Tool implementations are bound to a cwd and must keep filesystem access inside
that cwd.

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

`validation.run_commands` uses the command runner and passes only when every
command exits 0 and does not time out.

These features run on the host and must be treated as trusted host-local
execution.

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
