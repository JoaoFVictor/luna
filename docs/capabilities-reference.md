# Capabilities Reference

Capabilities are Luna's public registry for deterministic behavior. Workflow
YAML references capability ids. Agent tool resolution also uses capability
registrations. Treat manifests as the source of truth.

Source files:

- Official registry: `src/capabilities/registry.ts`
- Manifest contract: `src/core/capabilities/manifest.ts`
- Registry validation: `src/core/capabilities/registry.ts`

## Registry Rules

The registry validates:

- unique capability ids.
- declared dependencies.
- dependency cycles.
- duplicate public registration ids.
- duplicate intrinsic workflow-node owners.
- references to built-ins, patterns, gates, tools, policies, ports, schemas,
  and artifact publishers.
- re-export references.
- write side-effect policy metadata.
- validated side-effect categories used by Studio effect planning.
- duplicate side-effect operation ids.

Workflow YAML declares unqualified capability ids:

```yaml
capabilities:
  - reports
```

Nodes reference qualified registrations:

```yaml
uses: reports.final_report
```

Agent nodes select an agent definition rather than a capability registration.
Their execution owner is therefore declared by the capability manifest with
`workflow_node_types: ["agent"]`; validators, the compiler, and Studio catalog
all resolve the owner through the registry instead of assuming a capability id.

## Official Capabilities

| Capability | Purpose |
| --- | --- |
| `agents` | Agent runtime ports and agent node schemas. |
| `artifacts` | Artifact publisher and artifact reference schemas. |
| `context` | Repository and agent context intake. |
| `runtime` | Runtime preflight. |
| `repository-diff` | Read-only repository diff/context collection. |
| `repository-context` | Deterministic related repository impact context. |
| `findings` | Evidence validation for code review findings. |
| `reports` | Generic final report generation. |
| `pull-request-review` | Pull request review publication with inline comments. |
| `quality-gates` | Gated agent loop pattern and automated gates. |
| `validation` | Validation command execution. |
| `repository-change` | Trusted write worktree, validation, diff, commit, push lifecycle helpers. |
| `task-context` | Provider task context and final implementation reports. |
| `hitl` | Human approval gate and approval enforcement. |
| `repository` | Agent-local repository tools. |
| `local-exec` | Host command execution built-ins and ports. |
| `repository-workspace` | Read-only repository workspace capture. |
| `git` | Git status, commit, and push built-ins. |
| `change-request` | Change-request creation built-in and provider port. |
| `image-generation` | Provider-neutral raster image generation. |
| `social-post` | Provider-neutral social post publication. |
| `repository-write` | Bundle/re-export for trusted repository write capabilities. |

## Built-Ins

Runtime, context, and reports:

- `runtime.preflight`
- `context.collect_context`
- `repository-diff.collect_context`
- `repository-context.related_context`
- `review.coverage_plan`
- `review.coverage_check`
- `review.quality_check`
- `findings.validate_evidence`
- `reports.final_report`
- `pull-request-review.publish`
- `image-generation.generate`
- `social-post.apply_revision_scope`
- `social-post.prepare`
- `social-post.publish`
- `task-context.collect`
- `task-context.final_report`

Validation and HITL:

- `validation.run_commands`
- `hitl.require_approval`

Repository workspace/change lifecycle:

- `repository-workspace.capture`
- `repository-change.prepare_worktree`
- `repository-change.record_validation`
- `repository-change.collect_worktree_diff`
- `repository-change.record_acceptance_decision`
- `repository-change.prepare_commit`
- `repository-change.record_commit_lifecycle`
- `repository-change.prepare_push`
- `repository-change.record_push_lifecycle`

Host execution and publishing side effects:

- `local-exec.command.read`
- `local-exec.command.write`
- `git.status`
- `git.commit`
- `git.push_branch`
- `change-request.create`
- `pull-request-review.publish`

Provider-specific task context behavior is selected by `invocation.source`
inside provider/native composition; it does not add separate public built-in ids
for each provider.

`repository-context.related_context` is provider-neutral and read-only. It
receives `repo_context` plus optional budgets and returns
`luna.related_context.v1`: a small impact graph with `nodes`, `edges`,
ranked `files`, `budgets`, `truncation`, and `audit` metadata. The built-in is
language agnostic by contract, but uses stronger engines when they are
available. Internally it produces one Luna symbol graph shape inspired by SCIP:
occurrences use Luna symbol strings, SCIP-compatible `symbol_roles` bitsets,
typed UTF-16 ranges, and document-local symbol metadata. JS/TS uses TypeScript,
Vue uses Luna-owned
`@vue/compiler-sfc` plus TypeScript for SFC script/template blocks, and PHP uses
`nikic/php-parser` through the target repository's PHP autoload. After import
resolution, Luna links references back to resolved definition symbols before
ranking reverse references. Missing parser support falls back to deterministic
heuristics and is visible in `audit.warnings`; the actual engines are listed in
`audit.symbol_engines`. It skips dependency/build output and
local agent/editor tool directories, centers changed-file excerpts on diff
hunks, and resolves TypeScript/JavaScript
`paths` aliases and `baseUrl`, common root aliases such as `@/` and `~/`, PHP
`require`/`include`, Composer PSR-4 namespaces, reverse references, tests,
configs, docs, same-directory files, and similar abstraction names. Docs/config
edges are specific to matching changed seeds instead of being global edges to
every changed file. `truncation.omitted_paths` records a bounded sample of
ranked candidates excluded by `max_related_files`, and `omitted_count` records
the full excluded count, so a clean-looking graph can still expose budget
pressure without flooding agents. It is review context, not publication
evidence; inline PR comments still come from
validated findings whose evidence maps to captured PR diff lines.

`review.coverage_plan`, `review.coverage_check`, and `review.quality_check` are
provider-neutral review hardening built-ins. `coverage_plan` derives expected
review ranges from captured diff hunks and marks omitted or truncated changes
as blocked. `coverage_check` compares those expected ranges with reviewer
declared `reviewed_ranges`; this is auditable reviewer scope, not proof that a
model understood every line. `quality_check` converts deterministic review
quality signals into `pass`, `needs_human_review`, or `blocked`: blocked or
partial coverage, weak reviewed-range declarations without notes/risk tags,
related-context warnings/truncation, and unpublishable findings without
evidence. Acceptance agents should consume this artifact as gate input instead
of re-inferring review quality from prose.

`pull-request-review.publish` is provider-neutral. It receives the PR identity,
review event, body, optional acceptance result, validated findings, and
repository diff context from workflow state. The capability renders the PR body,
decides which findings can become inline comments, and resolves safe review
event behavior. `auto` follows the structured acceptance result with safe
downgrades: accepted reviews without findings can publish approvals, rejected
reviews with validated findings or blocking reasons can request changes, and
uncertain reviews publish regular review comments. Explicit no-finding
request-change attempts and approvals with findings or rejection are published
as regular review comments. The capability also applies provider-neutral
comment noise control before the selected provider calls the external PR review
API.

`image-generation.generate` persists the PNG immediately and returns an opaque,
content-addressed asset reference plus render-safe metadata. Binary bytes never
enter workflow state or checkpoints.
The bundled `pi-imagegen` integration loads the Pi extension, reuses Luna's
`openai-codex` OAuth credential, and executes its registered `imagegen` tool
with the extension-owned `gpt-image-2` model. No public OpenAI API key or Luna
OpenAI provider is involved.

Durable editorial revisions use the generic workflow `loop` node. Conditional
body nodes preserve unselected outputs exactly, and every iteration receives a
unique checkpoint, interrupt, execution identity, and artifact namespace.
`social-post.apply_revision_scope` is the provider-neutral trust boundary for
model proposals: the `text` target owns the publication text, strategy,
derived character count, and claims; the `image` target owns only the image
prompt. Fields outside the human-selected targets are copied from the prior
effective draft, regardless of what the agent proposes. A text-only revision
also skips image generation, preserving the opaque asset reference and hash.

`social-post.prepare` is provider-neutral and runs inside the editorial loop
before human review. It checks the immutable PNG bytes and hash against the
selected provider's declared upload contract. The capability enforces an
absolute 25 MiB safety ceiling; the bundled `x` provider declares its 5 MiB
image limit. An invalid image still reaches human review with an actionable
diagnostic, but the runtime rejects approval without resolving the interrupt;
the reviewer can request regeneration or reject the version.

`social-post.publish` accepts exactly the prepared text and opaque PNG asset
reference, repeats the immutable asset validation at the side-effect boundary,
uploads it through `POST /2/media/upload`,
and attaches its media id through `POST /2/tweets` with an OAuth user access
token. Its write policy forbids
automatic retry because a transport failure can leave publication outcome
unknown and a replay could create a duplicate post.

## Pattern

`quality-gates.gated_agent_loop`

Used for trusted local write repair loops. It runs a writer agent, validation,
diff summary, gate agents, and repair attempts. The pattern has an
`agent_session` batch exclusion key so the runner does not execute another
agent session concurrently in the same unsafe batch.

## Gates

Quality gates:

- `quality-gates.validation_commands`
- `quality-gates.agent_review`
- `quality-gates.non_empty_diff`

Human gates:

- `hitl.approval`
- `hitl.review`

Quality gates do not create runtime interrupts. `hitl.approval` creates a
required binary approval interrupt (`approve` or `reject`). `hitl.review`
creates a required editorial review interrupt that additionally accepts a
targeted `request_changes` decision for durable review loops. A review may
declare `review.approval.allowed` plus an actionable reason; when false, the
runtime rejects `approve` before resolving the interrupt while change requests
and rejection remain available.

`quality-gates.agent_review` accepts an optional collected `input.context`.
Context-dependent reviewers require the same explicit collector, dependency,
and exact `$.steps.<collector>` binding as direct agent and pattern-worker
participants.

## Policies

Side-effect policies:

- `local-exec.command_read_policy`
- `local-exec.command_write_policy`
- `repository-workspace.capture_policy`
- `git.status_read_policy`
- `git.commit_side_effect`
- `git.push_branch_side_effect`
- `change-request.create_side_effect`
- `pull-request-review.publish_side_effect`
- `image-generation.generate_side_effect`
- `social-post.publish_side_effect`

Workflow nodes that use side-effecting built-ins must declare the matching
policy with `operation_id`.

Policy registrations may also declare `side_effect_category`. The supported
manifest values are `provider_read`, `local_process`, `repository_write`, and
`external_write`. Studio projects this metadata into launch plans; capability ids
and prefixes never imply a category. A declared category requires compatible
read/write side-effect metadata, and registry validation rejects inconsistent
manifests.

Examples:

```yaml
policies:
  - uses: git.commit_side_effect
    config:
      operation_id: git.commit
```

`repository-write` re-exports the repository-write policy bundle so workflows
can depend on one higher-level capability when appropriate.

## Local Tools

Repository local tools:

- `repository.status`
- `repository.diff-summary`
- `repository.read-file`
- `repository.write-file`
- `repository.delete-file`

Mode rules:

- `status`, `diff-summary`, and `read-file` are valid for `read_only` and
  `trusted_local_write` agents.
- `write-file` and `delete-file` require `trusted_local_write`.

All local tools are bound to a cwd. Filesystem paths must stay inside that cwd.

MCP tools are derived from `config/mcp.yaml` policy, not from the repository
tool capability. Current bundled config has no MCP servers. The current Pi
adapter supports local tools only.

## Ports

Agent/runtime ports:

- `agents.runtime`

Artifact ports/schemas:

- `artifacts.manifest_store`
- `artifacts.artifact_ref`
- `artifacts.publisher_output`

Validation/local execution ports:

- `validation.runner`
- `local-exec.command_port`
- `local-exec.artifact_publisher`
- `local-exec.event_sink`

Repository/workspace/git ports:

- `repository-workspace.manager`
- `repository-workspace.lock_manager`
- `repository-workspace.event_sink`
- `git.repository`

Provider publishing port:

- `change-request.provider`
- `pull-request-review.provider`
- `image-generation.provider`
- `social-post.provider`

Ports are selected in runtime composition or native executor wiring, not in
agent prompts.

## Artifact Publisher

`artifacts.manifest_publisher`

Artifact rules:

- artifact paths are safe relative paths.
- source expressions must stay under the declaring node's `$.steps.<node>`.
- JSON artifacts must be JSON values.
- Markdown artifacts must be strings.
- required artifacts fail when the source is missing.
- duplicate artifact paths are prevented within a batch.
- default overwrite policy is `forbid`; supported config can use `replace`.

## Workflow Artifact Inventory

`code-review` writes:

- `preflight.json`
- `workspace.json`
- `repo-context.json`
- `related-context.json`
- `context-intake.json`
- `review-coverage-plan.json`
- `review-plan.json`
- `raw-code-review-findings.json`
- `security-review-findings.json`
- `architecture-review-findings.json`
- `merged-code-review-findings.json`
- `review-coverage-check.json`
- `code-review-findings.json`
- `review-quality.json`
- `acceptance-review.json`
- `pull-request-review.json`
- `final-report.json`
- `final-report.md`

`implementation` writes:

- `preflight.json`
- `workspace.json`
- `task-context.json`
- `context-intake.json`
- `implementation-plan.json`
- `implementation-result.json`
- `validation.json`
- `acceptance-review.json`
- `diff.json`
- `prepared-commit.json`
- `git-commit.json`
- `commit.json`
- `prepared-push.json`
- `git-push.json`
- `push.json`
- `change-request.json`
- `final-report.json`
- `final-report.md`

Example workflows write smaller subsets under their own workflow ids.

## Trusted Host-Local Caveat

`local-exec` and trusted repository write flows run on the host. They can
access local filesystem, credentials, network, and CLIs available to the Luna
process. Keep trusted write workflows behind explicit repository config,
validation, review gates, and human approval.
