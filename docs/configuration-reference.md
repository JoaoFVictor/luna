# Configuration Reference

Luna configuration lives under `config/` by default. Set `LUNA_CONFIG_ROOT` to
use another config directory.

## `app.yaml`

Controls workspace strategy, artifact root, runtime selection, and lock tuning.

Current defaults:

- workspace strategy: `git_worktree`.
- workspace root: `.runs/workspaces`.
- preserve failed run worktrees: true.
- preserve successful run worktrees: false.
- artifact root: `.runs`.
- workflow runtime: `langgraph`.
- agent runtime: `pi`.

`agent_runtime.options.request_timeout_ms` is passed to the Pi runtime factory.

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
- `skills`: optional repository skill paths relative to the prepared repository
  root.

Repository hints from invocations are matched against this config. Provider
payloads are not authoritative config.

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
- `sandbox.env_allowlist`: env vars passed to validation commands.
- `validation.repair_attempts`: gated-loop repair count.
- `validation.max_output_bytes`: captured command output budget.
- `validation.commands`: deterministic validation commands.

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
```

`queue.name` must be BullMQ-safe and must not contain `:`. `REDIS_URL` can
override `queue.redis_url` at process startup. Worker concurrency defaults to
`8`; use `webhook-worker --concurrency <n>` for a process-local override.

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

When running with Compose, `${LUNA_AUTH_ROOT:-./.luna/auth}` is mounted at
`/app/.luna/auth` and used by Luna, Pi, GitHub CLI, and SSH.

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
