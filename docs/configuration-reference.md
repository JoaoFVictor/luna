# Configuration Reference

Luna configuration lives under `config/` by default. Set `LUNA_CONFIG_ROOT` to
use another config directory.

## `app.yaml`

Controls workspace strategy, artifact root, runtime selection, and lock tuning.

Current defaults:

- workspace strategy: `git_worktree`.
- workspace root: `.runs/workspaces`.
- retain failed run worktrees: `preserve_on_failure` is required and must be
  `true`.
- retain successful run worktrees: `preserve_on_success` is required and must
  be `true`.
- artifact root: `.runs`.
- workflow runtime: `langgraph`.
- agent runtime: `pi`.

`agent_runtime.options.request_timeout_ms` is passed to the Pi runtime factory.

The two workspace retention fields are safety assertions, not cleanup toggles.
Setting either one to `false` is invalid. Luna does not delete worktrees during
success or failure terminalization. Cleanup will require a future, separately
confirmed operation with a durable journal and reconciliation of indeterminate
outcomes.

Optional lock config can set lock root and timeout duration.

## `routing.yaml`

Deterministic first-match routing rules.

Default rules:

1. explicit `invocation.target`.
2. GitHub PR selected/opened/synchronized/reopened events to
   `workflow:code-review`.
3. Jira selected issues to `workflow:implementation`.
4. Plane selected/create/update issues to `workflow:implementation`.

Rules are JSONata expressions evaluated over `{ invocation }`. Do not route
with model judgment.

## `repositories.yaml`

Declares repositories Luna may inspect or edit.

Important fields:

- `id`: local Luna repository id.
- `provider`, `owner`, `name`: source repository identity.
- `path`: local clone path.
- `remote`: git remote name.
- `expected_remote_urls`: required for trusted write workflows.
- `context.files`: repository context files collected by
  `context.collect_context`.
- `repository_context.exclude_globs`: optional repository-relative globs that
  are excluded from the canonical retrieval index and its agent query tool.
  These operator-bound excludes are case-insensitive, participate in snapshot
  identity, and cannot be overridden by model tool arguments.
- `skills`: optional repository skill paths relative to the prepared repository
  root.
- `validation.commands`: non-empty structured command/argument contracts used
  by trusted implementation workflows. Commands run from the prepared
  repository worktree without a shell.
- `validation.env_allowlist`: additional environment variable names made
  available to those commands. `PATH` is preserved for executable resolution;
  `HOME` is always an isolated temporary directory.

Repository hints from invocations are matched against this config. Provider
payloads are not authoritative config.

Validation is optional and repository-owned because repositories may use
different languages, frameworks, build systems, or a repository-provided
wrapper such as `./scripts/validate`. Luna does not detect a stack or select
commands at runtime. When the selected repository has no `validation` block,
the implementation workflow runs no validation command and continues through
its remaining gates. When present, the repository configuration and its
validation contract are included in the Studio repository fingerprint.

When running with Docker Compose, set repository `path` values to container
paths under `/repositories`, for example `/repositories/repo`. The host parent
directory is mounted with `LUNA_REPOSITORIES_ROOT`.

For local-only tests with real repositories, keep this committed file generic.
Use ignored local overrides instead: `docker-compose.override.yml` can mount
`.luna/local-config/repositories.yaml` over `/app/config/repositories.yaml`,
and `.env` can point `LUNA_REPOSITORIES_ROOT` at the host repositories parent.

## `models.yaml`

Defines named model profiles used by agents.

Bundled profiles:

- `default`
- `deep`
- `fast`
- `balanced`

Each profile can set model id, reasoning effort, and transport. Environment
substitution such as `${DEFAULT_MODEL:-...}` is supported by the config loader.

## `mcp.yaml`

Defines MCP server policy:

- server id.
- transport: `stdio`, `streamable-http`, or `sse`.
- command/args or HTTP endpoint settings.
- allowed tool ids.
- allowed agent modes.
- timeout.

The current bundled config has `mcp_servers: []`. MCP policy can be resolved,
but the current Pi runtime does not execute MCP tools.

## Workflow Runtime Config

Workflows that need runtime config declare it in `workflows/<id>/workflow.yaml`:

```yaml
config:
  file: <workflow-id>.yaml
  schema: config.schema.json
```

The native runtime loads `config/<file>`, validates it with the declared
workflow schema, and exposes it as `$.config`. Workflows without this block
receive an empty config object. The runtime does not special case workflow ids.
See [Workflow runtime config](workflow-runtime-config.md) for the full contract,
examples, ownership rules, and anti-patterns.

The bundled workflows currently use:

| Workflow | Config file | Schema |
| --- | --- | --- |
| `code-review` | `config/code-review.yaml` | `workflows/code-review/config.schema.json` |
| `implementation` | `config/implementation.yaml` | `workflows/implementation/config.schema.json` |

## `code-review.yaml`

Controls optional pull request review publication for the read-only
`code-review` workflow.

Fields:

- `review_dimensions`: optional operator-owned review rubric labels passed to
  the planner, reviewers, and acceptance reviewer. The bundled config includes
  `reuse_existing_components` so reviewers check whether the diff duplicates an
  existing abstraction instead of reusing it.
- `related_context.enabled`: whether to build the deterministic related
  repository impact graph before planning and reviewer agents run.
- `related_context.max_related_files`: maximum ranked files included in
  `related-context.json` and passed to agents. Defaults to `12` and is capped at
  `100`.
- `related_context.max_seed_files`: maximum changed/task-matched files promoted
  as graph seeds before related-file ranking. The index itself remains complete;
  this is a real output-selection budget, not a repository scan limit. Defaults
  to `5`, is capped at `100`, and cannot exceed `max_related_files`.
- `related_context.max_excerpt_bytes`: maximum excerpt bytes included per
  related file. Defaults to `4000` and is capped at `16384`; excerpts are
  materialized only after file selection, so rejected candidates do not inflate
  output memory. The complete output also caps query terms at `256` and
  deterministically ranked edges at `1000`; `omitted_edges_count` and
  `truncated_edge_text_count` expose any additional pressure.
- `related_context.include_tests`, `include_docs`, and `include_configs`:
  whether test/spec, documentation, and config relationships are included.
  Symbol parsing does not require configuration. Luna builds internal symbol
  graphs inspired by SCIP, with Luna symbol strings, SCIP-compatible
  `symbol_roles`, typed UTF-16 ranges, imports, and document symbols:
  TypeScript for JS/TS, Luna-owned Vue SFC parsing for `.vue`, and Luna-owned
  `nikic/php-parser` from the runtime image. Repository dependencies do not
  supply Luna's parser.
  The run records actual engines in `related-context.json` under
  `audit.symbol_engines` and parser fallback warnings under `audit.warnings`.
- `pull_request_review.enabled`: whether to publish the validated review back
  to the PR.
- `pull_request_review.provider`: provider id. The bundled provider is
  `github`.
- `pull_request_review.event`: formal PR review event: `auto`, `comment`,
  `request_changes`, or `approve`.
- `pull_request_review.inline_comments`: whether Luna should try to place
  validated findings as inline PR comments.
- `pull_request_review.comment_policy.inline_evidence`: `primary` places only
  the first evidence range inline and sends secondary evidence to the review
  body; `all` attempts every evidence range inline.
- `pull_request_review.comment_policy.max_inline_comments`: cap on inline
  comments for one published review.

Example:

```yaml
code_review:
  review_dimensions:
    - correctness
    - security
    - architecture
    - reuse_existing_components
    - tests
    - documentation
    - compatibility
  related_context:
    enabled: true
    max_related_files: 12
    max_seed_files: 8
    max_excerpt_bytes: 4000
    include_tests: true
    include_docs: true
    include_configs: true
  pull_request_review:
    enabled: true
    provider: github
    event: auto
    inline_comments: true
    comment_policy:
      inline_evidence: primary
      max_inline_comments: 20
```

Inline comments are created only for validated findings whose evidence maps to
right-side lines in the captured PR diff. By default Luna places the primary
evidence inline, deduplicates duplicate comment locations within one published
review, caps inline comments, and appends secondary or unplaceable evidence to
the review body. This does not deduplicate publication across separate runs. The
review body also includes the structured acceptance result, so a published
review can explicitly say `approved`, `changes requested`, `not accepted`, or
`needs human review` even when there are no inline comments. The side effect is
performed by the provider-neutral
`pull-request-review.publish` built-in and the selected provider port; GitHub
publishing uses `gh` auth under `.luna/auth/gh`.

`auto` uses the structured acceptance result with safe downgrades. Accepted
reviews without findings publish an approval, rejected reviews with validated
findings or blocking reasons request changes, and uncertain reviews publish a
regular PR review comment. Luna also prevents contradictory explicit events:
`request_changes` without findings or blocking reasons becomes `comment`, and
`approve` with findings or rejection becomes `comment`.

## `implementation.yaml`

Controls trusted repository-write publishing gates.

Fields:

- `branch_pattern`: implementation branch template.
- `commit.enabled`: whether commit is allowed.
- `push.enabled`: whether push is allowed.
- `push.remote`: remote used for push.
- `change_request.enabled`: whether to create a change request after push.
- `change_request.provider`: current provider id, usually `github`.
- `change_request.draft`: whether to open as draft.
- `change_request.base_ref`: target branch/ref.
- `sandbox.type`: current supported value is `trusted_host_local`.
- `validation.repair_attempts`: shared gated-loop repair budget for validation,
  technical-review, and acceptance failures. The shipped implementation config
  allows five repairs so a transient setup failure does not consume the only
  opportunity to apply reviewer feedback.
- `validation.max_output_bytes`: captured command output budget.

The implementation workflow requires automated validation, review, and
acceptance gates before diff/commit/push/change-request. HITL is demonstrated
in `workflows/example-complete-agent/`.

## Workflow Observability

Workflow YAML can configure the runtime-log projection:

```yaml
observability:
  exporters:
    runtime_log:
      enabled: true
      required: false
```

The filesystem artifact backend still writes required trace evidence under the
run directory. `runtime_log` is a compact projection into the selected runtime
log backend.

## `jira.yaml`

Declares Jira instances by id.

Fields:

- `id`
- `base_url`
- optional `repository_hint` field mapping.
- optional acceptance criteria field mapping.

Jira credentials are stored in `.luna/auth/luna.auth.json` under the Luna auth
root.

## `social-post.yaml`

Selects the social publishing provider and the named auth instance used by the
`social-post` workflow:

```yaml
image_generation:
  provider: pi-imagegen
  size: 1024x1024
  quality: medium
social_post:
  provider: x
  auth_instance: default
```

Each requested change durably preserves the previous version, regenerates only
the selected targets, and creates a new human review round. The workflow has no
configured revision cap; every human-triggered iteration has its own checkpoint,
interrupt identity, and artifact namespace.

Image generation reuses the Pi `openai-codex` OAuth credential in
`.luna/auth/pi-ai/auth.json`. X OAuth credentials belong in
`.luna/auth/luna.auth.json`; neither provider credential belongs in workflow
config. Request `offline.access` together with `tweet.read`, `tweet.write`,
`users.read`, and `media.write`, then configure the returned refresh token:

```json
{
  "providers": {
    "x": {
      "default": {
        "auth_type": "oauth2_user_access_token",
        "access_token": "<user-access-token>",
        "refresh_token": "<refresh-token>",
        "client_id": "<oauth2-client-id>",
        "expires_at": "2026-07-13T22:00:00.000Z"
      }
    }
  }
}
```

The token must represent the user that will publish the post and must have
write permission. `expires_at` is optional: when present, Luna refreshes the
token shortly before expiry; when absent, Luna refreshes after a confirmed
`401`. A confidential OAuth client must also set `client_secret`; a public PKCE
client must omit it. Successful refreshes atomically rotate `access_token`,
`refresh_token`, and `expires_at` in this file under an inter-process lock.
Access-token-only entries remain supported but cannot refresh automatically.

## `plane.yaml`

Declares Plane instances by id.

Fields:

- `id`
- `base_url`
- optional repository hint label mapping.

Plane API keys are stored in `.luna/auth/luna.auth.json` under the Luna auth
root.

## `webhooks.yaml`

Configures generic webhook ingress, queueing, and worker defaults.

```yaml
version: "2026-06"
server:
  host: "127.0.0.1"
  port: 4012
  body_limit_bytes: 1048576
queue:
  name: "luna-webhooks"
  redis_url: "redis://127.0.0.1:6379"
  dedupe_ttl_seconds: 604800
  remove_on_complete:
    age_seconds: 86400
    count: 1000
  remove_on_fail: false
worker:
  concurrency: 8
providers:
  github:
    enabled: true
    secret_ref: "providers.webhooks.github.secret"
  plane:
    enabled: true
    secret_ref: "providers.webhooks.plane.secret"
    config:
      issue_state_allowlist:
        - "In Progress"
```

`queue.name` must be BullMQ-safe and must not contain `:`. `REDIS_URL` can
override `queue.redis_url` at process startup. Worker concurrency defaults to
`8`; use `webhook-worker --concurrency <n>` for a process-local override.

Provider-specific options live under each provider's `config` object. Plane's
Work items webhook event can send create, update, delete, cycle, and module
changes. `config.issue_state_allowlist` keeps Luna from starting implementation
runs until a Plane state-change activity reports a matching `new_value`. With
the bundled config, work items are ignored until they are moved to `In Progress`.

The bundled `docker-compose.yml` uses that override to point webhook processes at the
Redis service with `REDIS_URL=redis://redis:6379`. It keeps `LUNA_CONFIG_ROOT`
at `/app/config`, sets `LUNA_AUTH_ROOT=/app/.luna/auth`, mounts `./config`
read-only, and expects Luna-owned auth at `/app/.luna/auth/luna.auth.json`.

`dedupe_ttl_seconds` is reserved for future explicit BullMQ deduplication. The
current MVP dedupes repeated deliveries with deterministic BullMQ job ids and
retains completed jobs according to `remove_on_complete`.

## Secrets

Do not commit secrets.

- Pi model auth is created by `npx @earendil-works/pi-ai login openai-codex`
  and stored for Luna under `.luna/auth/pi-ai/auth.json`.
- Jira and Plane provider auth live in `.luna/auth/luna.auth.json`.
- GitHub provider auth uses `gh` with `GH_CONFIG_DIR` under `.luna/auth/gh`;
  Luna does not define `github.yaml` or GitHub entries in `luna.auth.json`.
- Git commit identity lives in `.luna/auth/git/config` and is mounted into
  containers with `GIT_CONFIG_GLOBAL`.

When running with Compose, `${LUNA_AUTH_ROOT:-./.luna/auth}` is mounted at
`/app/.luna/auth` and used by Luna, Pi, GitHub CLI, Git, and SSH.

Webhook provider signing secrets are separate from provider API auth. They use
the `providers.webhooks` namespace in `.luna/auth/luna.auth.json` and are
resolved through the `secret_ref` fields in `config/webhooks.yaml`:

```json
{
  "providers": {
    "webhooks": {
      "github": { "secret": "..." },
      "plane": { "secret": "..." }
    }
  }
}
```

## Config Loading

The CLI resolves config root from `LUNA_CONFIG_ROOT` or the default config
location. Runtime composition validates backend selections and JSON options.
Provider modules validate only their own provider config/auth slices.

`LUNA_AUTH_ROOT` resolves the single auth root. Relative values resolve from
the project root. The default is `.luna/auth`.
